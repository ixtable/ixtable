import { evaluate } from "../../expr";
import { pageDimensions } from "../model";
import type { Band, Report, ReportGroup, TableComponent } from "../types";
import type {
  LayoutOptions,
  Page,
  PositionedItem,
  ReportDiagnostic,
  ReportDocument,
  Row,
} from "./document";
import {
  componentItems,
  measureTable,
  type RenderContext,
  type TableGeometry,
  tableRowItems,
} from "./render";

const EPS = 1e-6;

/** Tables in page headers and footers are not laid out (validation rejects them). */
export const PAGE_BAND_TABLE = "Tables are not supported in page headers or footers";

/** `groupPage`/`groupPages` count pages since the last group with `resetPageNumber`. */
type PageContext = { page: number; pages: number; groupPage: number; groupPages: number };
type Thunk = (ctx: PageContext) => PositionedItem[];

interface Block {
  band: Band;
  scope: Record<string, unknown>;
  /** Group header with keepTogether: keep it on the page of the next block. */
  keepWithNext: boolean;
  /** Start a new page before (band option, group `newPage` or `resetPageNumber`). */
  breakBefore: boolean;
  breakAfter: boolean;
  /** Starts a page-number section (header of a group with `resetPageNumber`). */
  section: boolean;
  /** Open group headers (outer first) to repeat at the top of continuation pages. */
  repeat: Block[];
}

interface Prepared extends Block {
  table?: { comp: TableComponent; geo: TableGeometry };
  height: number;
  splittable: boolean;
  /** Smallest first piece: whole band, or everything above the table plus header and one row. */
  minFirst: number;
}

const typeRank = (v: unknown) =>
  v === null || v === undefined
    ? 0
    : typeof v === "boolean"
      ? 1
      : typeof v === "number"
        ? 2
        : typeof v === "string"
          ? 3
          : 4;

/** Total order on group keys: null, booleans, numbers, text (by code unit), anything else. */
export function compareKeys(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  const x = ra === 4 ? JSON.stringify(a) : (a as number | string | boolean);
  const y = rb === 4 ? JSON.stringify(b) : (b as number | string | boolean);
  return x < y ? -1 : x > y ? 1 : 0;
}

const isEmptyBand = (band: Band) => band.height <= 0 && band.components.length === 0;

/**
 * Lays out a report into pages. Pure and deterministic: the same report,
 * rows and options always produce the same document on every platform.
 *
 * Rows are sorted (stable) by the group keys; group headers and footers see
 * the group's rows as `rows`; page headers and footers repeat on every page;
 * `page` and `pages` are resolved after pagination.
 */
export function layoutReport(
  report: Report,
  inputRows: Row[],
  options: LayoutOptions = {},
): ReportDocument {
  const { width, height } = pageDimensions(report.page);
  const m = report.page.margins;
  const bands = report.bands;
  const params = options.params ?? report.params ?? {};
  const diagnostics = new Map<string, ReportDiagnostic>();
  const diagnose = (componentId: string, message: string) => {
    const key = `${componentId}\u0000${message}`;
    if (!diagnostics.has(key)) diagnostics.set(key, { componentId, message });
  };
  const base = {
    params,
    report: { name: report.name },
    rows: inputRows,
    record: null,
    group: null,
    rowNumber: null,
    page: null,
    pages: null,
    groupPage: null,
    groupPages: null,
  };
  const context = (scope: Record<string, unknown>): RenderContext => ({
    scope,
    now: options.now,
    tables: options.tables ?? {},
    assets: options.assets ?? {},
    diagnose,
  });

  // 1. Sort rows by group keys (stable).
  const groups = bands.groups;
  const keyed = inputRows.map((row, index) => ({
    row,
    index,
    keys: groups.map((g) => groupKey(g, row, base, options.now, diagnose)),
  }));
  keyed.sort((a, b) => {
    for (let i = 0; i < groups.length; i++) {
      const c = compareKeys(a.keys[i], b.keys[i]);
      if (c) return groups[i].descending ? -c : c;
    }
    return a.index - b.index;
  });
  const rows = keyed.map((k) => k.row);

  // 2. Flatten into band instances.
  const blocks: Block[] = [];
  const open: Block[] = [];
  const block = (
    band: Band,
    scope: Record<string, unknown>,
    extra: Partial<Block> = {},
  ): Block => ({
    band,
    scope: { ...base, ...scope },
    keepWithNext: false,
    breakBefore: !!band.pageBreakBefore,
    breakAfter: !!band.pageBreakAfter,
    section: false,
    repeat: [...open],
    ...extra,
  });
  const push = (b: Block) => {
    // Empty bands are skipped unless they carry a page break or section start.
    if (!isEmptyBand(b.band) || b.breakBefore || b.breakAfter || b.section) blocks.push(b);
  };
  const reportBand = (band: Band, scope: Record<string, unknown>) =>
    push(block(band, scope, { repeat: [] }));
  reportBand(bands.reportHeader, { rows, record: rows[0] ?? null });
  let rowNumber = 0;
  const emit = (level: number, slice: typeof keyed) => {
    if (level === groups.length) {
      const sliceRows = slice.map((k) => k.row);
      for (const k of slice)
        push(block(bands.detail, { record: k.row, rows: sliceRows, rowNumber: ++rowNumber }));
      return;
    }
    const g = groups[level];
    let start = 0;
    while (start < slice.length) {
      let end = start + 1;
      while (
        end < slice.length &&
        compareKeys(slice[end].keys[level], slice[start].keys[level]) === 0
      )
        end++;
      const run = slice.slice(start, end);
      const runRows = run.map((k) => k.row);
      const group = { key: run[0].keys[level], level: level + 1, count: run.length };
      const header = block(
        g.header,
        { rows: runRows, record: runRows[0], group },
        {
          keepWithNext: g.header.keepTogether,
          breakBefore: !!(g.header.pageBreakBefore || g.newPage || g.resetPageNumber),
          section: !!g.resetPageNumber,
        },
      );
      push(header);
      const repeats = !!g.repeatHeader && !isEmptyBand(g.header);
      if (repeats) open.push(header);
      emit(level + 1, run);
      push(block(g.footer, { rows: runRows, record: runRows[runRows.length - 1], group }));
      if (repeats) open.pop();
      start = end;
    }
  };
  emit(0, keyed);
  reportBand(bands.reportFooter, { rows, record: rows[rows.length - 1] ?? null });

  // 3. Measure.
  const bodyTop = m.top + bands.pageHeader.height;
  const bodyBottom = height - m.bottom - bands.pageFooter.height;
  const bodyHeight = bodyBottom - bodyTop;
  const prepare = (block: Block): Prepared => {
    const comp = block.band.components.find((c): c is TableComponent => c.kind === "table");
    if (!comp)
      return {
        ...block,
        height: block.band.height,
        splittable: false,
        minFirst: block.band.height,
      };
    const geo = measureTable(comp, context(block.scope));
    const h = block.band.height + Math.max(0, geo.height - comp.h);
    const splittable = !block.band.keepTogether || h > bodyHeight + EPS;
    const minFirst = splittable ? comp.y + geo.headerHeight + (geo.rowHeights[0] ?? 0) : h;
    return { ...block, table: { comp, geo }, height: h, splittable, minFirst };
  };
  const preparedOf = new Map<Block, Prepared>();
  const prepareOnce = (b: Block) => {
    let p = preparedOf.get(b);
    if (!p) preparedOf.set(b, (p = prepare(b)));
    return p;
  };
  const prepared = blocks.map(prepareOnce);

  // 4. Paginate.
  const left = m.left;
  const pages: Thunk[][] = [];
  /** Page-number section of each page (see `groupPage`). */
  const pageSection: number[] = [];
  let sections = 0;
  let cursor = bodyTop;
  /** Cursor after the repeated group headers of the current page. */
  let pageTop = bodyTop;
  const add = (thunk: Thunk) => pages[pages.length - 1].push(thunk);
  const newPage = (repeat: Block[] = []) => {
    pages.push([]);
    pageSection.push(sections);
    cursor = bodyTop;
    for (const h of repeat) {
      const r = prepareOnce(h);
      const oy = cursor;
      add((ctx) => bandItems(r, left, oy, ctx, context, "all"));
      cursor += r.height;
    }
    pageTop = cursor;
  };
  const atTop = () => cursor <= pageTop + EPS;
  newPage();
  let pendingBreak = false;

  const firstNeed = (p: Prepared) => (p.splittable ? p.minFirst : p.height);
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    let need = firstNeed(p);
    if (p.keepWithNext) {
      need = 0;
      let j = i;
      while (j < prepared.length && prepared[j].keepWithNext) need += prepared[j++].height;
      if (j < prepared.length) need += firstNeed(prepared[j]);
    }
    if ((pendingBreak || p.breakBefore) && !atTop()) newPage(p.repeat);
    pendingBreak = p.breakAfter;
    if (p.section) pageSection[pages.length - 1] = ++sections;
    if (cursor + need > bodyBottom + EPS && !atTop()) newPage(p.repeat);
    if (!p.table || cursor + p.height <= bodyBottom + EPS || !p.splittable) {
      const oy = cursor;
      add((ctx) => bandItems(p, left, oy, ctx, context, "all"));
      cursor += p.height;
      continue;
    }
    // Split a table band across pages, repeating the header row.
    const { comp, geo } = p.table;
    const origin = cursor;
    add((ctx) => bandItems(p, left, origin, ctx, context, "above"));
    let y = origin + comp.y;
    let row = 0;
    let chunkAtTop = origin + comp.y <= pageTop + EPS;
    let broke = false;
    for (;;) {
      const top = y;
      const first = row;
      y += geo.headerHeight;
      while (
        row < geo.rowHeights.length &&
        (y + geo.rowHeights[row] <= bodyBottom + EPS || (row === first && chunkAtTop))
      )
        y += geo.rowHeights[row++];
      const last = row;
      add(() => [
        ...tableRowItems(comp, geo, -1, left + comp.x, top),
        ...rowsBetween(comp, geo, first, last, left + comp.x, top + geo.headerHeight),
      ]);
      if (row >= geo.rowHeights.length) break;
      newPage(p.repeat);
      broke = true;
      chunkAtTop = true;
      y = cursor;
    }
    const belowStart = comp.y + comp.h;
    if (!broke) y = Math.max(y, origin + belowStart);
    const rest = p.band.height - belowStart;
    const hasBelow = p.band.components.some((c) => c !== comp && c.y >= belowStart - EPS);
    if (hasBelow && y + rest > bodyBottom + EPS && y > pageTop + EPS) {
      newPage(p.repeat);
      y = cursor;
    }
    const oy = y - belowStart;
    if (hasBelow) add((ctx) => bandItems(p, left, oy, ctx, context, "below"));
    cursor = y + Math.max(0, rest);
  }

  // 5. Render with page numbers known.
  const total = pages.length;
  const pageBand = (band: Band, oy: number, ctx: PageContext) =>
    band.components.flatMap((c) => {
      if (c.kind !== "table") return componentItems(c, left, oy, context({ ...base, ...ctx }));
      diagnose(c.id, PAGE_BAND_TABLE);
      return [];
    });
  const out: Page[] = pages.map((thunks, index) => {
    const section = pageSection[index];
    const first = pageSection.indexOf(section);
    const ctx = {
      page: index + 1,
      pages: total,
      groupPage: index - first + 1,
      groupPages: pageSection.lastIndexOf(section) - first + 1,
    };
    return {
      number: index + 1,
      items: [
        ...pageBand(bands.pageHeader, m.top, ctx),
        ...thunks.flatMap((thunk) => thunk(ctx)),
        ...pageBand(bands.pageFooter, height - m.bottom - bands.pageFooter.height, ctx),
      ],
    };
  });
  return { width, height, pages: out, diagnostics: [...diagnostics.values()] };
}

function groupKey(
  group: ReportGroup,
  record: Row,
  base: Record<string, unknown>,
  now: Date | undefined,
  diagnose: (id: string, message: string) => void,
): unknown {
  if (!group.groupBy.trim()) return null;
  try {
    return evaluate(group.groupBy, { ...base, record }, { now });
  } catch (error) {
    diagnose(group.id, error instanceof Error ? error.message : String(error));
    return null;
  }
}

function rowsBetween(
  comp: TableComponent,
  geo: TableGeometry,
  from: number,
  to: number,
  x: number,
  y: number,
): PositionedItem[] {
  const items: PositionedItem[] = [];
  for (let i = from; i < to; i++) {
    items.push(...tableRowItems(comp, geo, i, x, y));
    y += geo.rowHeights[i];
  }
  return items;
}

/**
 * Items of one band instance at origin (left, oy). `part` selects components:
 * "all", "above" (everything not below the table, without the table), or
 * "below" (components under the table, placed relative to `oy`).
 */
function bandItems(
  p: Prepared,
  left: number,
  oy: number,
  page: PageContext,
  context: (scope: Record<string, unknown>) => RenderContext,
  part: "all" | "above" | "below",
): PositionedItem[] {
  const ctx = context({ ...p.scope, ...page });
  const table = p.table;
  const belowStart = table ? table.comp.y + table.comp.h : Number.POSITIVE_INFINITY;
  const growth = table ? Math.max(0, table.geo.height - table.comp.h) : 0;
  return p.band.components.flatMap((c) => {
    if (c.kind === "table") {
      if (part !== "all" || c !== table?.comp) return [];
      return [
        ...tableRowItems(c, table.geo, -1, left + c.x, oy + c.y),
        ...rowsBetween(
          c,
          table.geo,
          0,
          table.geo.rowHeights.length,
          left + c.x,
          oy + c.y + table.geo.headerHeight,
        ),
      ];
    }
    const below = c.y >= belowStart - EPS;
    if (part === "above" && below) return [];
    if (part === "below") return below ? componentItems(c, left, oy, ctx) : [];
    return componentItems(c, left, oy + (below && part === "all" ? growth : 0), ctx);
  });
}
