/**
 * Dashboard definitions (PRD §16). Mirrors `src-tauri/src/dashboards.rs` (serde camelCase).
 * `layout` and `placement` are the shared grid types forms use (src/grid).
 */
import type { FormMode } from "../design/schema";
import type { GridLayout, Placement } from "../grid/types";

export type FilterControl = "select" | "text" | "date" | "number" | "dateRange";
export const FILTER_CONTROLS: FilterControl[] = ["select", "text", "date", "number", "dateRange"];

/** A dashboard-wide input. Its value is passed to every component query as `$param`. */
export interface DashboardFilter {
  id: string;
  name: string;
  // Query parameter name. A `dateRange` filter sets `<param>From` and `<param>To`.
  param: string;
  logicalType: string;
  default?: unknown;
  control: FilterControl;
  // Fixed choices for `select`.
  options?: string[];
  // Saved query whose first column lists the `select` choices.
  optionsQueryId?: string | null;
}

export type ComponentKind =
  | "kpi"
  | "table"
  | "chart"
  | "filter"
  | "form"
  | "report"
  | "button"
  | "text";
export const COMPONENT_KINDS: ComponentKind[] = [
  "kpi",
  "chart",
  "table",
  "filter",
  "form",
  "report",
  "button",
  "text",
];

export type ChartType = "bar" | "line" | "area" | "pie" | "donut" | "scatter" | "summary";
export const CHART_TYPES: ChartType[] = [
  "bar",
  "line",
  "area",
  "pie",
  "donut",
  "scatter",
  "summary",
];

export interface KpiComparison {
  valueField?: string | null;
  expression?: string | null;
  label: string;
}

/** One component on the dashboard grid. Fields a kind does not use stay unset. */
export interface DashboardComponent {
  id: string;
  kind: ComponentKind;
  title: string;
  placement: Placement;
  // kpi, table, chart
  queryId?: string | null;
  // kpi: column read from the first row.
  valueField?: string | null;
  // kpi: expression over `rows` and `params`; wins over `valueField`.
  expression?: string | null;
  // kpi, chart: src/expr format pattern.
  format?: string | null;
  comparison?: KpiComparison | null;
  // table: shown columns; empty shows all.
  columns?: string[];
  pageSize?: number | null;
  chartType?: ChartType | null;
  x?: string | null;
  // chart: value columns, one series each.
  y?: string[];
  // chart: splits the first y column into one series per value.
  groupBy?: string | null;
  stacked?: boolean;
  filterId?: string | null;
  formId?: string | null;
  mode?: FormMode | null;
  reportId?: string | null;
  actionId?: string | null;
  label?: string | null;
  // text: plain text; blank lines separate paragraphs.
  text?: string | null;
}

export interface Dashboard {
  id: string;
  name: string;
  layout: GridLayout;
  filters: DashboardFilter[];
  components: DashboardComponent[];
}
