/** Dashboard definition helpers: creation, duplication, placement, normalization, checks. */
import {
  defaultGridLayout,
  movePlacement,
  nextPlacement,
  normalizeLayout,
  normalizePlacement,
  resizePlacement,
  validateLayout,
} from "../grid/engine";
import { type DesignForm, FORM_MODES, type FormMode } from "../design/schema";
import { clampRegions, type RegionRenames, remapRegion } from "../grid/regions";
import type { GridIssue, GridLayout, SpanConstraints } from "../grid/types";
import type { DocumentConfig } from "../lib/types";
import { newId } from "../lib/utils";
import {
  CHART_TYPES,
  type ChartType,
  type ComponentKind,
  type Dashboard,
  type DashboardComponent,
  type DashboardFilter,
  FILTER_CONTROLS,
} from "./types";

export const KIND_LABELS: Record<ComponentKind, string> = {
  kpi: "KPI",
  chart: "Chart",
  table: "Table",
  filter: "Filter",
  form: "Form",
  report: "Report",
  button: "Action button",
  text: "Text",
};

export const CHART_LABELS: Record<ChartType, string> = {
  bar: "Bar",
  line: "Line",
  area: "Area",
  pie: "Pie",
  donut: "Donut",
  scatter: "Scatter",
  summary: "Summary",
};

/** Default size on a 12-column grid, and resize limits, per component kind. */
const SIZES: Record<ComponentKind, { columnSpan: number; rowSpan: number; min: SpanConstraints }> =
  {
    kpi: { columnSpan: 3, rowSpan: 1, min: { minColumnSpan: 2 } },
    chart: { columnSpan: 6, rowSpan: 2, min: { minColumnSpan: 3, minRowSpan: 2 } },
    table: { columnSpan: 6, rowSpan: 2, min: { minColumnSpan: 3 } },
    filter: { columnSpan: 3, rowSpan: 1, min: { minColumnSpan: 2 } },
    form: { columnSpan: 6, rowSpan: 3, min: { minColumnSpan: 4, minRowSpan: 2 } },
    report: { columnSpan: 12, rowSpan: 4, min: { minColumnSpan: 6, minRowSpan: 2 } },
    button: { columnSpan: 2, rowSpan: 1, min: {} },
    text: { columnSpan: 4, rowSpan: 1, min: {} },
  };

export const constraintsFor = (kind: ComponentKind): SpanConstraints => SIZES[kind].min;

export function newDashboard(name: string): Dashboard {
  return { id: newId(), name, layout: defaultGridLayout(), filters: [], components: [] };
}

export function newFilter(name: string, param: string): DashboardFilter {
  return { id: newId(), name, param, logicalType: "text", control: "select", options: [] };
}

/** A new component of `kind` at the first free slot of the dashboard grid. */
export function newComponent(
  kind: ComponentKind,
  dashboard: Dashboard,
  extra: Partial<DashboardComponent> = {},
): DashboardComponent {
  const count = dashboard.layout.columns.length;
  const size = SIZES[kind];
  const placement = nextPlacement(
    dashboard.layout,
    dashboard.components.map((c) => c.placement),
    { columnSpan: Math.min(size.columnSpan, count), rowSpan: size.rowSpan },
  );
  const n = dashboard.components.filter((c) => c.kind === kind).length + 1;
  const base: DashboardComponent = {
    id: newId(),
    kind,
    title: `${KIND_LABELS[kind]} ${n}`,
    placement,
  };
  switch (kind) {
    case "chart":
      return { ...base, chartType: "bar", queryId: null, x: null, y: [], ...extra };
    case "table":
      return { ...base, queryId: null, columns: [], pageSize: 10, ...extra };
    case "kpi":
      return { ...base, queryId: null, valueField: null, expression: null, ...extra };
    case "button":
      return { ...base, label: "Run", actionId: null, ...extra };
    case "form":
      return { ...base, formId: null, mode: "list", ...extra };
    case "text":
      return { ...base, text: "", ...extra };
    default:
      return { ...base, ...extra };
  }
}

/** A copy with fresh ids; filter components follow their copied filters. */
export function duplicateDashboard(dashboard: Dashboard, name: string): Dashboard {
  const filterIds = new Map(dashboard.filters.map((f) => [f.id, newId()]));
  return {
    ...structuredClone(dashboard),
    id: newId(),
    name,
    filters: dashboard.filters.map((f) => ({
      ...structuredClone(f),
      id: filterIds.get(f.id) ?? newId(),
    })),
    components: dashboard.components.map((c) => ({
      ...structuredClone(c),
      id: newId(),
      filterId: c.filterId ? (filterIds.get(c.filterId) ?? c.filterId) : c.filterId,
    })),
  };
}

/** Clamps every placement into the layout's base columns (after a column-count change). */
export function withLayout(
  dashboard: Dashboard,
  next: GridLayout,
  renames: RegionRenames = {},
): Dashboard {
  const layout = { ...next, namedRegions: clampRegions(next.namedRegions, next.columns.length) };
  return {
    ...dashboard,
    layout,
    components: dashboard.components.map((c) => ({
      ...c,
      placement: resizePlacement(
        movePlacement(remapRegion(c.placement, layout.namedRegions, renames), {}, layout),
        {},
        layout,
        constraintsFor(c.kind),
      ),
    })),
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Fills serde defaults the way `dashboards.rs` does: the layout and placements go through
 * the shared grid normalizers, so a dashboard serializes to the same grid JSON as a form.
 */
export function normalizeDashboard(value: unknown): Dashboard {
  const d = record(value);
  const filters = Array.isArray(d.filters) ? d.filters.map(record) : [];
  const components = Array.isArray(d.components) ? d.components.map(record) : [];
  return {
    id: String(d.id ?? ""),
    name: String(d.name ?? ""),
    layout: normalizeLayout(d.layout ?? {}),
    filters: filters.map((f) => ({
      ...(f as unknown as DashboardFilter),
      id: String(f.id ?? ""),
      name: String(f.name ?? ""),
      param: String(f.param ?? ""),
      logicalType: typeof f.logicalType === "string" ? f.logicalType : "text",
      control: FILTER_CONTROLS.includes(f.control as never)
        ? (f.control as DashboardFilter["control"])
        : "text",
    })),
    components: components.map((c) => ({
      ...(c as unknown as DashboardComponent),
      id: String(c.id ?? ""),
      title: String(c.title ?? ""),
      placement: normalizePlacement(c.placement ?? {}),
      ...(c.chartType !== undefined && c.chartType !== null
        ? {
            chartType: CHART_TYPES.includes(c.chartType as ChartType)
              ? (c.chartType as ChartType)
              : "bar",
          }
        : {}),
    })),
  };
}

/** Editor-side checks: the shared grid rules plus missing references (mirrors dashboards.rs). */
export function dashboardIssues(dashboard: Dashboard, config: DocumentConfig): GridIssue[] {
  const issues = validateLayout(
    dashboard.layout,
    dashboard.components.map((c) => ({ id: c.id, placement: c.placement })),
    { objectKind: "dashboard", objectId: dashboard.id, itemKind: "dashboardComponent" },
  );
  const error = (id: string, message: string) =>
    issues.push({ severity: "error", objectKind: "dashboardComponent", objectId: id, message });
  const has = <T extends { id: string }>(items: T[] | undefined, id?: string | null) =>
    !id || (items ?? []).some((item) => item.id === id);
  for (const c of dashboard.components) {
    const title = c.title || c.id;
    if (!has(config.savedQueries, c.queryId))
      error(c.id, `"${title}" uses a saved query that does not exist`);
    if (!has(config.design?.forms, c.formId))
      error(c.id, `"${title}" embeds a form that does not exist`);
    if (!has(config.reports, c.reportId))
      error(c.id, `"${title}" embeds a report that does not exist`);
    if (!has(config.actions, c.actionId))
      error(c.id, `button "${title}" runs an action that does not exist`);
    if (c.kind === "filter" && !dashboard.filters.some((f) => f.id === c.filterId))
      error(c.id, `"${title}" shows a filter that does not exist`);
    if (c.kind === "table" && (c.styles ?? []).some((s) => !s.column?.trim()))
      error(c.id, `"${title}" has a conditional style with no column`);
  }
  return issues;
}

/** Parameters declared by the saved queries this dashboard's components use. */
export function dashboardQueryParameters(
  dashboard: Dashboard,
  queries: { id: string; parameters?: { name: string; logicalType: string }[] }[],
) {
  const ids = new Set(dashboard.components.map((c) => c.queryId).filter(Boolean));
  const seen = new Map<string, string>();
  for (const q of queries) {
    if (!ids.has(q.id)) continue;
    for (const p of q.parameters ?? []) if (!seen.has(p.name)) seen.set(p.name, p.logicalType);
  }
  return [...seen].map(([name, logicalType]) => ({ name, logicalType }));
}

/**
 * Modes a dashboard can open `form` in: the form's own modes, minus create and
 * edit for read-only query sources (all modes while no form is chosen).
 */
export function embeddableModes(form: DesignForm | null | undefined): FormMode[] {
  if (!form) return [...FORM_MODES];
  const readOnly = form.source?.kind === "query";
  return form.modes.filter((m) => !(readOnly && (m === "create" || m === "edit")));
}
