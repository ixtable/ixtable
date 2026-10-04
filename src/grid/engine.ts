/**
 * Shared grid engine for forms and dashboards. Pure functions only: no React, no DOM.
 *
 * Breakpoint rule: breakpoints are mobile-first. For a container width `w`, the active
 * column set is the breakpoint with the largest `minWidth <= w` (ties: the later one in the
 * array). Breakpoints with no columns are ignored. With no match, or no width, the base
 * `layout.columns` apply. Placements and regions are always authored against the base
 * columns; breakpoints only change how they render.
 *
 * Wrapping rule (applied separately to placements and to named regions):
 * 1. If every rectangle fits the active column count, positions are kept exactly as authored.
 * 2. Otherwise the set reflows. Rectangles are visited in authored reading order
 *    (row, column, array index). Each column span is clamped to the active column count; the
 *    row span is kept. Each rectangle is placed at the first free slot found by scanning from
 *    (authored row + shift, min(authored column, count - span + 1)) to the end of that row,
 *    then row by row from column 1. `shift` starts at 0 and becomes the largest number of
 *    rows any earlier rectangle was pushed down, so later rows move down with the rows they
 *    follow and reading order is preserved.
 */
import type {
  Breakpoint,
  GridAlign,
  GridContainerCss,
  GridDelta,
  GridIssue,
  GridItemCss,
  GridItemRef,
  GridLayout,
  GridTrack,
  NamedRegion,
  Placement,
  ResolvedRegion,
  SpanConstraints,
  TrackKind,
} from "./types";

const DEFAULT_COLUMNS = 12;
const DEFAULT_GAP = 16;
const MAX_U16 = 65535;
const MAX_U32 = 4294967295;
const TRACK_KINDS: readonly TrackKind[] = ["fixed", "content", "fr"];
const ALIGNS: readonly GridAlign[] = ["stretch", "start", "center", "end"];
const RESERVED_IDENTS = new Set(["auto", "span", "none", "inherit", "initial", "unset", "revert"]);

type Rect = { column: number; row: number; columnSpan: number; rowSpan: number };

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const px = (value: number) => `${value}px`;

export const defaultGridLayout = (): GridLayout => ({
  columns: Array.from({ length: DEFAULT_COLUMNS }, () => ({
    kind: "fr",
    value: 1,
    min: null,
    max: null,
  })),
  rows: [],
  columnGap: DEFAULT_GAP,
  rowGap: DEFAULT_GAP,
  padding: 0,
  justifyItems: "stretch",
  alignItems: "stretch",
  namedRegions: [],
  breakpoints: [],
});

/**
 * One track to CSS. `fixed` → clamped px; `content` → `auto`; `fr` → `Nfr`.
 * With min or max, `content` and `fr` become `minmax(min, max)` where a missing min is
 * `0px` (fr) or `auto` (content) and a missing max is the base size.
 */
export const trackToCss = (track: GridTrack): string => {
  if (track.kind === "fixed") {
    const size = clamp(track.value ?? 0, track.min ?? -Infinity, track.max ?? Infinity);
    return px(size);
  }
  const base = track.kind === "fr" ? `${track.value ?? 1}fr` : "auto";
  if (track.min == null && track.max == null) return base;
  const min = track.min != null ? px(track.min) : track.kind === "fr" ? "0px" : "auto";
  const max = track.max != null ? px(track.max) : base;
  return `minmax(${min}, ${max})`;
};

const FALLBACK_COLUMNS: GridTrack[] = [{ kind: "fr", value: 1 }];

/** Active column tracks for a container width; `index` is -1 for the base columns. */
export const resolveBreakpoint = (
  layout: GridLayout,
  width?: number,
): { columns: GridTrack[]; index: number } => {
  let index = -1;
  let best = -Infinity;
  if (width != null && Number.isFinite(width)) {
    layout.breakpoints.forEach((breakpoint, i) => {
      if (
        breakpoint.columns.length &&
        breakpoint.minWidth <= width &&
        breakpoint.minWidth >= best
      ) {
        best = breakpoint.minWidth;
        index = i;
      }
    });
  }
  const columns = index < 0 ? layout.columns : layout.breakpoints[index].columns;
  return { columns: columns.length ? columns : FALLBACK_COLUMNS, index };
};

const activeColumnCount = (layout: GridLayout, width?: number) =>
  resolveBreakpoint(layout, width).columns.length;

const rectFits = (rect: Rect, count: number) =>
  rect.column >= 1 &&
  rect.row >= 1 &&
  rect.columnSpan >= 1 &&
  rect.rowSpan >= 1 &&
  rect.column + rect.columnSpan - 1 <= count;

const cellsOf = (rect: Rect) => {
  const cells: string[] = [];
  for (let r = rect.row; r < rect.row + rect.rowSpan; r += 1) {
    for (let c = rect.column; c < rect.column + rect.columnSpan; c += 1) cells.push(`${r}:${c}`);
  }
  return cells;
};

const isFree = (occupied: Set<string>, rect: Rect) =>
  cellsOf(rect).every((cell) => !occupied.has(cell));

const occupy = (occupied: Set<string>, rect: Rect) => {
  for (const cell of cellsOf(rect)) occupied.add(cell);
};

/** Applies the wrapping rule documented at the top of this file. */
const reflow = <T extends Rect>(rects: readonly T[], count: number): T[] => {
  if (rects.every((rect) => rectFits(rect, count))) return [...rects];
  const order = rects
    .map((_, i) => i)
    .sort((a, b) => rects[a].row - rects[b].row || rects[a].column - rects[b].column || a - b);
  const occupied = new Set<string>();
  const out = [...rects];
  let shift = 0;
  for (const i of order) {
    const source = rects[i];
    const authoredRow = Math.max(1, Math.floor(source.row));
    const columnSpan = clamp(Math.floor(source.columnSpan), 1, count);
    const rowSpan = Math.max(1, Math.floor(source.rowSpan));
    const lastColumn = count - columnSpan + 1;
    const rect = {
      column: clamp(Math.floor(source.column), 1, lastColumn),
      row: authoredRow + shift,
      columnSpan,
      rowSpan,
    };
    while (!isFree(occupied, rect)) {
      rect.column += 1;
      if (rect.column > lastColumn) {
        rect.column = 1;
        rect.row += 1;
      }
    }
    occupy(occupied, rect);
    shift = Math.max(shift, rect.row - authoredRow);
    out[i] = { ...source, ...rect };
  }
  return out;
};

const isSafeIdent = (name: string) =>
  /^[A-Za-z][A-Za-z0-9-]*$/.test(name) && !RESERVED_IDENTS.has(name.toLowerCase());

/** Named regions as rendered at `width`, with their CSS identifiers. */
export const resolveRegions = (layout: GridLayout, width?: number): ResolvedRegion[] => {
  const count = activeColumnCount(layout, width);
  const occupied = new Set<string>();
  const seen = new Set<string>();
  return reflow(layout.namedRegions, count).map((region, index) => {
    const inTemplate =
      region.name !== "" &&
      !seen.has(region.name) &&
      rectFits(region, count) &&
      isFree(occupied, region);
    if (inTemplate) occupy(occupied, region);
    seen.add(region.name);
    return { ...region, ident: isSafeIdent(region.name) ? region.name : `_${index}`, inTemplate };
  });
};

const templateAreas = (regions: ResolvedRegion[], count: number): string | undefined => {
  const placed = regions.filter((region) => region.inTemplate);
  if (!placed.length) return undefined;
  const rows = Math.max(...placed.map((region) => region.row + region.rowSpan - 1));
  const matrix = Array.from({ length: rows }, () => Array.from({ length: count }, () => "."));
  for (const region of placed) {
    for (const cell of cellsOf(region)) {
      const [r, c] = cell.split(":").map(Number);
      matrix[r - 1][c - 1] = region.ident;
    }
  }
  return matrix.map((line) => `"${line.join(" ")}"`).join(" ");
};

/** Container CSS for a layout at an optional container width (content-box pixels). */
export const layoutToCss = (
  layout: GridLayout,
  opts: { width?: number } = {},
): GridContainerCss => {
  const { columns } = resolveBreakpoint(layout, opts.width);
  const css: GridContainerCss = {
    display: "grid",
    gridTemplateColumns: columns.map(trackToCss).join(" "),
    gridAutoRows: "auto",
    columnGap: layout.columnGap,
    rowGap: layout.rowGap,
    padding: layout.padding,
    justifyItems: layout.justifyItems,
    alignItems: layout.alignItems,
  };
  if (layout.rows.length) css.gridTemplateRows = layout.rows.map(trackToCss).join(" ");
  const areas = templateAreas(resolveRegions(layout, opts.width), columns.length);
  if (areas) css.gridTemplateAreas = areas;
  return css;
};

const linesCss = (rect: Rect): GridItemCss => ({
  gridColumn: `${rect.column} / span ${rect.columnSpan}`,
  gridRow: `${rect.row} / span ${rect.rowSpan}`,
});

const clampRect = (rect: Rect, count: number): Rect => {
  const columnSpan = clamp(rect.columnSpan, 1, count);
  return {
    column: clamp(rect.column, 1, count - columnSpan + 1),
    row: Math.max(1, rect.row),
    columnSpan,
    rowSpan: Math.max(1, rect.rowSpan),
  };
};

const itemCss = (placement: Placement, regions: ResolvedRegion[], count: number): GridItemCss => {
  const region = placement.region
    ? regions.find((candidate) => candidate.name === placement.region)
    : undefined;
  if (region?.inTemplate) return { gridArea: region.ident };
  return linesCss(clampRect(region ?? placement, count));
};

/**
 * CSS for one item. Region placements use `grid-area`; others use line spans clamped to the
 * active columns. Use `placementsToCss` to also apply the wrapping rule across siblings.
 * With `layout === null` a region name is used as-is when it is a safe CSS identifier.
 */
export const placementToCss = (
  placement: Placement,
  layout: GridLayout | null,
  width?: number,
): GridItemCss => {
  if (!layout) {
    if (placement.region && isSafeIdent(placement.region)) return { gridArea: placement.region };
    return linesCss(clampRect(placement, Infinity));
  }
  return itemCss(placement, resolveRegions(layout, width), activeColumnCount(layout, width));
};

const regionNames = (layout: GridLayout) => new Set(layout.namedRegions.map((r) => r.name));

/** Placements as rendered at `width`: explicit placements wrap; region placements are kept. */
export const resolvePlacements = (
  layout: GridLayout,
  placements: readonly Placement[],
  width?: number,
): Placement[] => {
  const names = regionNames(layout);
  const usesRegion = (placement: Placement) => !!placement.region && names.has(placement.region);
  const explicit = placements.filter((placement) => !usesRegion(placement));
  const wrapped = reflow(explicit, activeColumnCount(layout, width));
  let next = 0;
  return placements.map((placement) => {
    if (usesRegion(placement)) return placement;
    const result = wrapped[next];
    next += 1;
    return result;
  });
};

/** CSS for a set of sibling placements at `width`, with wrapping applied. */
export const placementsToCss = (
  layout: GridLayout,
  placements: readonly Placement[],
  width?: number,
): GridItemCss[] => {
  const regions = resolveRegions(layout, width);
  const count = activeColumnCount(layout, width);
  return resolvePlacements(layout, placements, width).map((placement) =>
    itemCss(placement, regions, count),
  );
};

export const placementsEqual = (a: Placement, b: Placement) =>
  a.column === b.column &&
  a.row === b.row &&
  a.columnSpan === b.columnSpan &&
  a.rowSpan === b.rowSpan &&
  (a.region ?? null) === (b.region ?? null);

/**
 * Grows or shrinks a placement by whole tracks. Column span stays within
 * [max(1, minColumnSpan), min(columns - column + 1, maxColumnSpan)] of the base columns; row
 * span within [max(1, minRowSpan), maxRowSpan ?? 65535]. The grid wins over item limits.
 * Region placements are sized by their region and are returned unchanged.
 */
export const resizePlacement = (
  placement: Placement,
  delta: GridDelta,
  layout: GridLayout,
  constraints: SpanConstraints = {},
): Placement => {
  if (placement.region) return placement;
  const count = Math.max(1, layout.columns.length);
  const column = clamp(placement.column, 1, count);
  const maxColumns = Math.max(1, Math.min(count - column + 1, constraints.maxColumnSpan ?? count));
  const minColumns = clamp(constraints.minColumnSpan ?? 1, 1, maxColumns);
  const maxRows = Math.max(1, Math.min(constraints.maxRowSpan ?? MAX_U16, MAX_U16));
  const minRows = clamp(constraints.minRowSpan ?? 1, 1, maxRows);
  return {
    ...placement,
    column,
    columnSpan: clamp(placement.columnSpan + (delta.columns ?? 0), minColumns, maxColumns),
    rowSpan: clamp(placement.rowSpan + (delta.rows ?? 0), minRows, maxRows),
  };
};

/** Moves a placement by whole tracks, keeping it inside the base columns and row >= 1. */
export const movePlacement = (
  placement: Placement,
  delta: GridDelta,
  layout: GridLayout,
): Placement => {
  if (placement.region) return placement;
  const count = Math.max(1, layout.columns.length);
  const columnSpan = clamp(placement.columnSpan, 1, count);
  return {
    ...placement,
    columnSpan,
    column: clamp(placement.column + (delta.columns ?? 0), 1, count - columnSpan + 1),
    row: clamp(placement.row + (delta.rows ?? 0), 1, MAX_U16),
  };
};

const rectOf = (placement: Placement, layout?: GridLayout): Rect | undefined => {
  if (!placement.region) return placement;
  return layout?.namedRegions.find((region) => region.name === placement.region);
};

const intersects = (a: Rect, b: Rect) =>
  a.column < b.column + b.columnSpan &&
  b.column < a.column + a.columnSpan &&
  a.row < b.row + b.rowSpan &&
  b.row < a.row + a.rowSpan;

/**
 * First free slot (row-major from row 1, column 1) in the base columns for a new item.
 * The default size is the full width and one row.
 */
export const nextPlacement = (
  layout: GridLayout,
  existing: readonly Placement[],
  size: { columnSpan?: number; rowSpan?: number } = {},
): Placement => {
  const count = Math.max(1, layout.columns.length);
  const occupied = new Set<string>();
  for (const placement of existing) {
    const rect = rectOf(placement, layout);
    if (rect) occupy(occupied, rect);
  }
  const rect = {
    column: 1,
    row: 1,
    columnSpan: clamp(size.columnSpan ?? count, 1, count),
    rowSpan: Math.max(1, size.rowSpan ?? 1),
  };
  while (!isFree(occupied, rect)) {
    rect.column += 1;
    if (rect.column > count - rect.columnSpan + 1) {
      rect.column = 1;
      rect.row += 1;
    }
  }
  return { ...rect, region: null };
};

/** Pairs of item ids whose authored cells overlap (items in the same region overlap). */
export const detectOverlaps = (
  items: readonly GridItemRef[],
  layout?: GridLayout,
): Array<[string, string]> => {
  const overlaps: Array<[string, string]> = [];
  const rects = items.map((item) => rectOf(item.placement, layout));
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i].placement;
      const b = items[j].placement;
      const sameRegion = !!a.region && a.region === b.region;
      const ra = rects[i];
      const rb = rects[j];
      if (sameRegion || (ra && rb && intersects(ra, rb))) overlaps.push([items[i].id, items[j].id]);
    }
  }
  return overlaps;
};

const isWhole = (value: number, max: number) =>
  Number.isInteger(value) && value >= 0 && value <= max;

type IssueTarget = { objectKind: string; objectId: string };

const trackIssues = (tracks: GridTrack[], label: string, target: IssueTarget): GridIssue[] => {
  const issues: GridIssue[] = [];
  const error = (message: string) => issues.push({ severity: "error", ...target, message });
  if (!tracks.length && label === "columns") {
    error("grid layout requires at least one column track");
  }
  for (const track of tracks) {
    if (track.kind !== "content" && !((track.value ?? 0) > 0)) {
      error(`${label} tracks need a positive size`);
    }
    if (track.min != null && track.max != null && track.min > track.max) {
      error(`${label} track minimum cannot exceed maximum`);
    }
  }
  return issues;
};

const spanIssue = (rect: Rect, columns: number): string | undefined => {
  const values = [rect.column, rect.row, rect.columnSpan, rect.rowSpan];
  if (!values.every((value) => isWhole(value, MAX_U16))) {
    return "grid positions and spans must be whole numbers up to 65535";
  }
  if (values.some((value) => value === 0)) {
    return "grid placement uses 1-based positions and positive spans";
  }
  if (rect.column + rect.columnSpan - 1 > columns) return "grid placement exceeds declared columns";
  return undefined;
};

const breakpointIssues = (breakpoints: Breakpoint[], target: IssueTarget): GridIssue[] => {
  const issues: GridIssue[] = [];
  const widths = new Set<number>();
  for (const breakpoint of breakpoints) {
    issues.push(...trackIssues(breakpoint.columns, "breakpoint columns", target));
    if (!isWhole(breakpoint.minWidth, MAX_U32)) {
      issues.push({
        severity: "error",
        ...target,
        message: "breakpoint widths must be whole pixels",
      });
    }
    if (!breakpoint.columns.length) {
      issues.push({
        severity: "warning",
        ...target,
        message: "breakpoint has no columns and is ignored",
      });
    }
    if (widths.has(breakpoint.minWidth)) {
      const message = `more than one breakpoint starts at ${breakpoint.minWidth}px; the last one wins`;
      issues.push({ severity: "warning", ...target, message });
    }
    widths.add(breakpoint.minWidth);
  }
  return issues;
};

const regionIssues = (regions: NamedRegion[], columns: number, target: IssueTarget) => {
  const issues: GridIssue[] = [];
  const names = new Set<string>();
  regions.forEach((region, index) => {
    if (!region.name || names.has(region.name)) {
      issues.push({ severity: "error", ...target, message: "named grid regions must be unique" });
    }
    names.add(region.name);
    const message = spanIssue(region, columns);
    if (message)
      issues.push({ severity: "error", ...target, message: `region ${region.name}: ${message}` });
    const clash = regions.slice(0, index).find((other) => intersects(other, region));
    if (clash) {
      const message = `region ${region.name} overlaps region ${clash.name} and is left out of the template`;
      issues.push({ severity: "warning", ...target, message });
    }
  });
  return issues;
};

/**
 * Mirrors the grid rules of `DesignSchema::validate` in design.rs as errors. Values that Rust
 * cannot deserialize are errors too. Rendering problems Rust accepts (overlapping items or
 * regions, ignored breakpoints) are warnings.
 */
export const validateLayout = (
  layout: GridLayout,
  items: readonly GridItemRef[],
  opts: { objectKind?: string; objectId?: string; itemKind?: string } = {},
): GridIssue[] => {
  const target = { objectKind: opts.objectKind ?? "layout", objectId: opts.objectId ?? "" };
  const itemKind = opts.itemKind ?? "item";
  const columns = layout.columns.length;
  const issues: GridIssue[] = [
    ...trackIssues(layout.columns, "columns", target),
    ...trackIssues(layout.rows, "rows", target),
    ...breakpointIssues(layout.breakpoints, target),
  ];
  if (
    ![layout.columnGap, layout.rowGap, layout.padding].every((value) => isWhole(value, MAX_U16))
  ) {
    const message = "gaps and padding must be whole pixels up to 65535";
    issues.push({ severity: "error", ...target, message });
  }
  if (!ALIGNS.includes(layout.justifyItems) || !ALIGNS.includes(layout.alignItems)) {
    issues.push({ severity: "error", ...target, message: "unknown grid alignment" });
  }
  issues.push(...regionIssues(layout.namedRegions, columns, target));
  const names = regionNames(layout);
  for (const item of items) {
    const { placement } = item;
    const message = placement.region
      ? names.has(placement.region)
        ? undefined
        : "placement references an unknown region"
      : spanIssue(placement, columns);
    if (message)
      issues.push({ severity: "error", objectKind: itemKind, objectId: item.id, message });
  }
  for (const [a, b] of detectOverlaps(items, layout)) {
    const message = `overlaps ${b}`;
    issues.push({ severity: "warning", objectKind: itemKind, objectId: a, message });
  }
  return issues;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const num = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const optNum = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const list = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined);

const normalizeTrack = (value: unknown): GridTrack => {
  const track = record(value);
  return {
    kind: pick(track.kind, TRACK_KINDS, "fr"),
    value: optNum(track.value),
    min: optNum(track.min),
    max: optNum(track.max),
  };
};

/** Fills serde defaults and keeps only schema keys, in Rust field order. */
export const normalizePlacement = (value: unknown): Placement => {
  const placement = record(value);
  return {
    column: num(placement.column, 1),
    row: num(placement.row, 1),
    columnSpan: num(placement.columnSpan, 1),
    rowSpan: num(placement.rowSpan, 1),
    region: typeof placement.region === "string" ? placement.region : null,
  };
};

/**
 * Fills serde defaults and drops unknown keys (including any CSS someone stored), in Rust
 * field order, so `normalizeLayout(JSON.parse(JSON.stringify(x)))` is stable and matches the
 * JSON the Rust side writes.
 */
export const normalizeLayout = (value: unknown): GridLayout => {
  const layout = record(value);
  const defaults = defaultGridLayout();
  return {
    columns: list(layout.columns)?.map(normalizeTrack) ?? defaults.columns,
    rows: list(layout.rows)?.map(normalizeTrack) ?? [],
    columnGap: num(layout.columnGap, DEFAULT_GAP),
    rowGap: num(layout.rowGap, DEFAULT_GAP),
    padding: num(layout.padding, 0),
    justifyItems: pick(layout.justifyItems, ALIGNS, "stretch"),
    alignItems: pick(layout.alignItems, ALIGNS, "stretch"),
    namedRegions: (list(layout.namedRegions) ?? []).map((item) => {
      const region = record(item);
      return {
        name: typeof region.name === "string" ? region.name : "",
        column: num(region.column, 1),
        row: num(region.row, 1),
        columnSpan: num(region.columnSpan, 1),
        rowSpan: num(region.rowSpan, 1),
      };
    }),
    breakpoints: (list(layout.breakpoints) ?? []).map((item) => {
      const breakpoint = record(item);
      return {
        minWidth: num(breakpoint.minWidth, 0),
        columns: (list(breakpoint.columns) ?? []).map(normalizeTrack),
      };
    }),
  };
};
