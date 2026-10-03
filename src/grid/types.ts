/**
 * TypeScript mirror of the renderer-agnostic grid schema in `src-tauri/src/design.rs`
 * (`GridLayout`, `GridTrack`, `TrackKind`, `GridAlign`, `NamedRegion`, `Breakpoint`,
 * `Placement`). Field names and order match the serde camelCase output so a normalized
 * layout serializes to the same JSON the Rust side writes. No CSS is stored here: CSS is
 * derived on demand by `src/grid/engine.ts`.
 */

/** `fixed` = pixels, `content` = sized by content, `fr` = share of free space. */
export type TrackKind = "fixed" | "content" | "fr";

export type GridTrack = {
  kind: TrackKind;
  // Pixels for `fixed`, fraction for `fr`, ignored for `content`.
  value?: number | null;
  // Minimum track size in pixels.
  min?: number | null;
  // Maximum track size in pixels.
  max?: number | null;
};

export type GridAlign = "stretch" | "start" | "center" | "end";

export type NamedRegion = {
  name: string;
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
};

/** Replaces the column tracks when the container is at least `minWidth` pixels wide. */
export type Breakpoint = { minWidth: number; columns: GridTrack[] };

export type GridLayout = {
  columns: GridTrack[];
  rows: GridTrack[];
  columnGap: number;
  rowGap: number;
  padding: number;
  justifyItems: GridAlign;
  alignItems: GridAlign;
  namedRegions: NamedRegion[];
  breakpoints: Breakpoint[];
};

/** 1-based grid position. When `region` is set the item fills that named region. */
export type Placement = {
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
  region?: string | null;
};

/**
 * Per-item resize limits supplied by the caller (for example by control or widget kind).
 * They are not persisted on the placement; the grid itself (column count) is always enforced.
 */
export type SpanConstraints = {
  minColumnSpan?: number;
  maxColumnSpan?: number;
  minRowSpan?: number;
  maxRowSpan?: number;
};

/** A placed item, identified by a stable id. */
export type GridItemRef = { id: string; placement: Placement };

export type GridDelta = { columns?: number; rows?: number };

/** Same shape as `archive::Issue` on the Rust side. */
export type GridIssue = {
  severity: "error" | "warning";
  objectKind: string;
  objectId: string;
  message: string;
};

/** Derived container CSS. Structurally assignable to React `CSSProperties`. */
export type GridContainerCss = {
  display: "grid";
  gridTemplateColumns: string;
  gridTemplateRows?: string;
  gridTemplateAreas?: string;
  gridAutoRows: string;
  columnGap: number;
  rowGap: number;
  padding: number;
  justifyItems: GridAlign;
  alignItems: GridAlign;
};

/** Derived item CSS. Structurally assignable to React `CSSProperties`. */
export type GridItemCss = { gridArea: string } | { gridColumn: string; gridRow: string };

/** A named region as rendered at a given width (after wrapping). */
export type ResolvedRegion = NamedRegion & {
  // CSS identifier used in `grid-template-areas` (the name when it is a safe ident).
  ident: string;
  // False when the region overlaps an earlier region and is left out of the template.
  inTemplate: boolean;
};
