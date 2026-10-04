/**
 * Report definitions (PRD §15). Mirrors `reports::Report` in src-tauri/src/reports.rs.
 * All positions and sizes are in PDF points (1/72 inch). Components sit at
 * absolute positions inside their band; the band is as wide as the page
 * content area (page width minus left and right margins).
 */

export type PageSize = "A4" | "Letter";
export type Orientation = "portrait" | "landscape";
export type TextAlign = "left" | "center" | "right";

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PageSetup {
  size: PageSize;
  orientation: Orientation;
  margins: Margins;
}

/**
 * Presentation settings. Colors are gray levels only (0 = black, 1 = white) so
 * every report stays readable when printed without color (PRD §27.4).
 */
export interface ComponentStyle {
  /** Points. Default 10. */
  fontSize?: number;
  bold?: boolean;
  align?: TextAlign;
  /** Border (text, image, rectangle) or stroke (line) width in points. 0 = none. */
  borderWidth?: number;
  /** Background gray level; absent or null = transparent. */
  fill?: number | null;
  /** Text and stroke gray level. Default 0 (black). */
  gray?: number;
}

interface ComponentBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  style?: ComponentStyle;
}

export interface StaticTextComponent extends ComponentBase {
  kind: "staticText";
  text: string;
}
/** A bound field: an expression over the current row, usually `record.<column>`. */
export interface FieldComponent extends ComponentBase {
  kind: "field";
  expression: string;
  format?: string;
}
/** A calculated value: totals (`sum(rows.amount)`), page numbers (`page & ' of ' & pages`), … */
export interface CalculatedComponent extends ComponentBase {
  kind: "calculated";
  expression: string;
  format?: string;
}
export interface ImageComponent extends ComponentBase {
  kind: "image";
  /** Application asset (attachment) id. */
  assetId: string;
}
export interface LineComponent extends ComponentBase {
  kind: "line";
  orientation: "horizontal" | "vertical";
}
export interface RectangleComponent extends ComponentBase {
  kind: "rectangle";
}
export interface TableColumn {
  id: string;
  header: string;
  /** Evaluated per table row with that row as `record`. */
  expression: string;
  format?: string;
  /** Points. */
  width: number;
  align?: TextAlign;
}
/**
 * A query-backed table. Rows come from `queryId` (a saved query) or, when it is
 * empty, from the band's `rows` (the whole report or the current group). The
 * table grows past its designed height and splits across pages, repeating the
 * header row on every page.
 */
export interface TableComponent extends ComponentBase {
  kind: "table";
  queryId?: string;
  columns: TableColumn[];
}

export type ReportComponent =
  | StaticTextComponent
  | FieldComponent
  | CalculatedComponent
  | ImageComponent
  | LineComponent
  | RectangleComponent
  | TableComponent;
export type ComponentKind = ReportComponent["kind"];

export interface Band {
  height: number;
  /**
   * Never split this band across pages; on a group header, also keep the
   * header on the same page as the first row that follows it.
   */
  keepTogether: boolean;
  components: ReportComponent[];
}

export interface ReportGroup {
  id: string;
  /** Expression evaluated per row, e.g. `record.region`. */
  groupBy: string;
  descending?: boolean;
  header: Band;
  footer: Band;
}

export interface Bands {
  reportHeader: Band;
  pageHeader: Band;
  /** Outer group first. */
  groups: ReportGroup[];
  detail: Band;
  pageFooter: Band;
  reportFooter: Band;
}

export interface Report {
  id: string;
  name: string;
  /** Saved query that supplies the rows. Takes precedence over `table`. */
  datasetQueryId?: string | null;
  /** Table or view read in full when no saved query is set. */
  table?: string | null;
  /** Default parameter values; passed to the dataset query and exposed as `params`. */
  params: Record<string, unknown>;
  page: PageSetup;
  bands: Bands;
}
