/** Design tab: component palette, the editable shared grid canvas, and the properties panel. */
import {
  BarChart3,
  FileText,
  Filter,
  Gauge,
  type LucideIcon,
  MousePointerClick,
  PanelsTopLeft,
  Table2,
  Type,
} from "lucide-react";
import { useMemo, useState } from "react";
import { LayoutSettings } from "../design/LayoutSettings";
import { GridCanvas, GridItem } from "../grid";
import type { Placement } from "../grid/types";
import { useDocumentConfig } from "../lib/config-store";
import { ComponentProperties } from "./ComponentProperties";
import { dashboardParams, defaultFilterValues } from "./data";
import { ROW_HEIGHT } from "./DashboardView";
import { FiltersEditor } from "./FiltersEditor";
import {
  CHART_LABELS,
  constraintsFor,
  dashboardIssues,
  KIND_LABELS,
  newComponent,
  withLayout,
} from "./model";
import {
  COMPONENT_KINDS,
  type ComponentKind,
  type Dashboard,
  type DashboardComponent,
} from "./types";

const ICONS: Record<ComponentKind, LucideIcon> = {
  kpi: Gauge,
  chart: BarChart3,
  table: Table2,
  filter: Filter,
  form: PanelsTopLeft,
  report: FileText,
  button: MousePointerClick,
  text: Type,
};

type Edit = (fn: (d: Dashboard) => Dashboard, label?: string) => void;

export function DashboardEditor({
  dashboard,
  edit,
  focusId,
}: {
  dashboard: Dashboard;
  edit: Edit;
  /** Component to select on mount (a Problems link). */
  focusId?: string;
}) {
  const { config } = useDocumentConfig();
  const [selectedId, setSelectedId] = useState<string | undefined>(focusId);
  const selected = dashboard.components.find((c) => c.id === selectedId);
  const params = useMemo(
    () => dashboardParams(dashboard.filters, defaultFilterValues(dashboard.filters)),
    [dashboard.filters],
  );
  const issues = dashboardIssues(dashboard, config);

  const add = (kind: ComponentKind, extra: Partial<DashboardComponent> = {}) => {
    const component = newComponent(kind, dashboard, extra);
    setSelectedId(component.id);
    edit((d) => ({ ...d, components: [...d.components, component] }), `Add ${KIND_LABELS[kind]}`);
  };
  const changeComponent = (
    id: string,
    patch: Partial<DashboardComponent>,
    label = "Edit component",
  ) =>
    edit(
      (d) => ({
        ...d,
        components: d.components.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      }),
      label,
    );
  const place = (id: string, placement: Placement) =>
    changeComponent(id, { placement }, "Move component");

  return (
    <section className="form-studio dash-studio" aria-label="Dashboard designer">
      <aside className="studio-components fd-left">
        <small>COMPONENTS</small>
        <div className="fd-palette" role="group" aria-label="Add component">
          {COMPONENT_KINDS.map((kind) => {
            const Icon = ICONS[kind];
            return (
              <button key={kind} type="button" onClick={() => add(kind)}>
                <Icon aria-hidden="true" /> Add{" "}
                {kind === "kpi" ? "KPI" : KIND_LABELS[kind].toLowerCase()}
              </button>
            );
          })}
        </div>
      </aside>
      <div className="studio-canvas dash-canvas">
        {dashboard.components.length ? (
          <GridCanvas
            layout={dashboard.layout}
            editable
            selectedId={selectedId}
            onSelect={setSelectedId}
            onResize={place}
            onMove={place}
            label={`${dashboard.name} layout`}
          >
            {dashboard.components.map((c) => (
              <GridItem
                key={c.id}
                id={c.id}
                placement={c.placement}
                label={c.title || KIND_LABELS[c.kind]}
                constraints={constraintsFor(c.kind)}
              >
                <Card component={c} dashboard={dashboard} rowGap={dashboard.layout.rowGap} />
              </GridItem>
            ))}
          </GridCanvas>
        ) : (
          <p className="fd-hint">
            Add components from the palette. They snap to the dashboard grid.
          </p>
        )}
        {issues.length > 0 && (
          <ul className="dash-issues" aria-label="Dashboard problems">
            {issues.map((issue, i) => (
              <li key={i} className={issue.severity}>
                {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      <aside className="studio-properties" aria-label="Properties">
        {selected ? (
          <>
            <button type="button" className="fd-link" onClick={() => setSelectedId(undefined)}>
              Dashboard settings
            </button>
            <ComponentProperties
              key={selected.id}
              dashboard={dashboard}
              component={selected}
              params={params}
              change={(patch, label) => changeComponent(selected.id, patch, label)}
              remove={() => {
                setSelectedId(undefined);
                edit(
                  (d) => ({ ...d, components: d.components.filter((c) => c.id !== selected.id) }),
                  "Delete component",
                );
              }}
            />
          </>
        ) : (
          <>
            <small>DASHBOARD SETTINGS</small>
            <FiltersEditor
              dashboard={dashboard}
              onChange={(filters, label) =>
                edit(
                  (d) => ({
                    ...d,
                    filters,
                    components: d.components.filter(
                      (c) =>
                        c.kind !== "filter" ||
                        !c.filterId ||
                        filters.some((f) => f.id === c.filterId),
                    ),
                  }),
                  label,
                )
              }
              onPlace={(filter) => add("filter", { filterId: filter.id, title: filter.name })}
            />
            <LayoutSettings
              title="Dashboard grid"
              layout={dashboard.layout}
              onChange={(layout, renames) =>
                edit((d) => withLayout(d, layout, renames), "Edit dashboard grid")
              }
            />
          </>
        )}
      </aside>
    </section>
  );
}

function summary(
  c: DashboardComponent,
  dashboard: Dashboard,
  queryName: (id?: string | null) => string,
) {
  switch (c.kind) {
    case "kpi":
      return `${queryName(c.queryId)} · ${c.expression || c.valueField || "no value"}`;
    case "chart":
      return `${CHART_LABELS[c.chartType ?? "bar"]} · ${queryName(c.queryId)} · ${c.x ?? "?"} → ${(c.y ?? []).join(", ") || "?"}`;
    case "table":
      return `${queryName(c.queryId)} · ${c.pageSize ?? 10} rows per page`;
    case "filter":
      return dashboard.filters.find((f) => f.id === c.filterId)?.name ?? "No filter";
    case "form":
      return c.formId ? `Form · ${c.mode ?? "list"}` : "No form";
    case "report":
      return c.reportId ? "Report preview" : "No report";
    case "button":
      return c.actionId ? `Runs an action · “${c.label ?? ""}”` : "No action";
    case "text":
      return c.text?.slice(0, 80) || "Empty text";
    default:
      return "";
  }
}

function Card({
  component,
  dashboard,
  rowGap,
}: {
  component: DashboardComponent;
  dashboard: Dashboard;
  rowGap: number;
}) {
  const { config } = useDocumentConfig();
  const queryName = (id?: string | null) =>
    id ? (config.savedQueries.find((q) => q.id === id)?.name ?? "Missing query") : "No query";
  const span = component.placement.rowSpan;
  return (
    <div
      className="fd-card dash-card"
      style={{ minHeight: span * ROW_HEIGHT * 0.6 + (span - 1) * rowGap }}
    >
      <div className="fd-card-head">
        <b>{component.title || KIND_LABELS[component.kind]}</b>
        <span>{KIND_LABELS[component.kind]}</span>
      </div>
      <small>{summary(component, dashboard, queryName)}</small>
    </div>
  );
}
