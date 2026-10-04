/** Live dashboard: filter bar, components on the shared grid, parallel query loading. */
import { CircleStop, RefreshCw } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { DATABASE_CHANGED_EVENT } from "../automation/context";
import { runAction } from "../automation/runner";
import { GridCanvas, GridItem } from "../grid";
import { useDocumentConfig } from "../lib/config-store";
import { RECORDS_CHANGED_EVENT } from "../lib/records";
import { ReportPreview } from "../reports";
import { useConfirm } from "../runtime/Confirm";
import { type PageKind, useRuntimeNavigation } from "../runtime/navigation";
import { can } from "../runtime/rbac";
import { EmbeddedForm } from "./EmbeddedForm";
import { dashboardParams, defaultFilterValues, type FilterValue, resultRows } from "./data";
import { KIND_LABELS, normalizeDashboard } from "./model";
import type { Dashboard, DashboardComponent } from "./types";
import { type QueryState, useDashboardData } from "./useDashboardData";
import { ChartBody, FilterInput, KpiBody, QueryGate, TableBody, TextBody } from "./widgets";
import "./dashboards.css";

/** Height of one dashboard grid row in pixels; spans add the row gap between rows. */
export const ROW_HEIGHT = 120;

export type DashboardViewProps = {
  dashboardId: string;
  // Initial filter values by parameter name (for example from a navigate action).
  params?: Record<string, unknown>;
};

/** Renders a dashboard live. Exported for Runtime navigation (`PageView`) and the Studio View tab. */
export function DashboardView({ dashboardId, params }: DashboardViewProps) {
  const { config } = useDocumentConfig();
  const raw = (config.dashboards ?? []).find((d) => d.id === dashboardId);
  // Hand-written YAML may leave out serde defaults; fill them like dashboards.rs does.
  const dashboard = useMemo(() => (raw ? normalizeDashboard(raw) : undefined), [raw]);
  if (!dashboard)
    return (
      <p className="dash-error" role="alert">
        This dashboard does not exist.
      </p>
    );
  return <LiveDashboard key={dashboard.id} dashboard={dashboard} initial={params} />;
}

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

function LiveDashboard({
  dashboard,
  initial,
}: {
  dashboard: Dashboard;
  initial?: Record<string, unknown>;
}) {
  const { config } = useDocumentConfig();
  const runtime = useRuntimeNavigation();
  const [dialog, confirm] = useConfirm();
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [values, setValues] = useState<Record<string, FilterValue>>(() => {
    const defaults = defaultFilterValues(dashboard.filters);
    for (const f of dashboard.filters)
      if (initial && f.param in initial) defaults[f.id] = initial[f.param];
    return defaults;
  });
  const settled = useDebounced(values, 250);
  // Page parameters stay in scope; filter values override parameters of the same name.
  const params = useMemo(
    () => ({ ...initial, ...dashboardParams(dashboard.filters, settled) }),
    [initial, dashboard.filters, settled],
  );
  const queryIds = useMemo(() => {
    const ids = dashboard.components
      .filter((c) => ["kpi", "table", "chart"].includes(c.kind) && c.queryId)
      .map((c) => c.queryId as string);
    return [...new Set(ids)].filter((id) => can(config, runtime.roleId, "query", id, "read"));
  }, [dashboard.components, config, runtime.roleId]);
  const data = useDashboardData(queryIds, params);
  const { refresh } = data;

  useEffect(() => {
    window.addEventListener(DATABASE_CHANGED_EVENT, refresh);
    window.addEventListener(RECORDS_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(DATABASE_CHANGED_EVENT, refresh);
      window.removeEventListener(RECORDS_CHANGED_EVENT, refresh);
    };
  }, [refresh]);

  const placed = new Set(
    dashboard.components.filter((c) => c.kind === "filter").map((c) => c.filterId),
  );
  const barFilters = dashboard.filters.filter((f) => !placed.has(f.id));
  const setFilter = (id: string, value: FilterValue) => setValues((v) => ({ ...v, [id]: value }));
  const scope = { params, app: runtime.app };

  const notify = (text: string, tone: "info" | "error" = "info") => {
    setNotice({ text, tone });
    if (runtime.attached) runtime.notify(text, tone);
  };
  const runButton = async (component: DashboardComponent) => {
    if (!component.actionId) return;
    const result = await runAction(component.actionId, {
      config,
      app: runtime.app,
      params,
      navigate: (target) => {
        if (runtime.attached) runtime.navigate({ ...target, kind: target.kind as PageKind });
        else
          notify(
            `This action opens a ${target.kind}. Open it in the Runtime to follow navigation.`,
          );
      },
      setState: (where, key, value) => {
        // Validation rejects form-scope state on dashboard buttons: there is no form here.
        if (where === "app") runtime.setAppState(key, value);
        else throw new Error("A dashboard button cannot set form state.");
      },
      confirm,
      notify,
      authorize: (kind, id, op) => can(config, runtime.roleId, kind, id, op as "read"),
      refresh,
    });
    if (!result.ok && result.error) notify(result.error, "error");
  };

  const stateOf = (c: DashboardComponent): QueryState | undefined =>
    c.queryId && !can(config, runtime.roleId, "query", c.queryId, "read")
      ? { status: "denied" }
      : c.queryId
        ? data.states[c.queryId]
        : undefined;

  const body = (c: DashboardComponent) => {
    switch (c.kind) {
      case "kpi":
        return (
          <QueryGate component={c} state={stateOf(c)}>
            {(result) => <KpiBody component={c} rows={resultRows(result)} scope={scope} />}
          </QueryGate>
        );
      case "chart":
        return (
          <QueryGate component={c} state={stateOf(c)}>
            {(result) => <ChartBody component={c} rows={resultRows(result)} />}
          </QueryGate>
        );
      case "table":
        return (
          <QueryGate component={c} state={stateOf(c)}>
            {(result) => <TableBody component={c} result={result} />}
          </QueryGate>
        );
      case "filter": {
        const filter = dashboard.filters.find((f) => f.id === c.filterId);
        return filter ? (
          <FilterInput
            filter={filter}
            value={values[filter.id]}
            onChange={(v) => setFilter(filter.id, v)}
          />
        ) : (
          <p className="dash-muted">Choose a filter.</p>
        );
      }
      case "form":
        return c.formId ? (
          <EmbeddedForm component={c} params={params} />
        ) : (
          <p className="dash-muted">Choose a form.</p>
        );
      case "report":
        return c.reportId ? (
          <ReportPreview reportId={c.reportId} params={params} />
        ) : (
          <p className="dash-muted">Choose a report.</p>
        );
      case "button": {
        const allowed = !c.actionId || can(config, runtime.roleId, "action", c.actionId, "execute");
        return (
          <button
            type="button"
            className="dash-action"
            disabled={!c.actionId || !allowed}
            onClick={() => {
              runButton(c).catch((reason) => notify(String(reason), "error"));
            }}
          >
            {c.label || c.title || "Run"}
          </button>
        );
      }
      case "text":
        return <TextBody text={c.text ?? ""} />;
      default:
        return null;
    }
  };

  const minHeight = (c: DashboardComponent): CSSProperties => ({
    minHeight:
      c.placement.rowSpan * ROW_HEIGHT + (c.placement.rowSpan - 1) * dashboard.layout.rowGap,
  });

  return (
    <div className="dash-view">
      <div className="dash-toolbar" role="toolbar" aria-label={`${dashboard.name} filters`}>
        {barFilters.map((filter) => (
          <FilterInput
            key={filter.id}
            filter={filter}
            value={values[filter.id]}
            onChange={(v) => setFilter(filter.id, v)}
          />
        ))}
        <button type="button" className="dash-refresh" onClick={refresh}>
          <RefreshCw aria-hidden="true" /> Refresh
        </button>
      </div>
      {data.slow && (
        <div className="dash-progress" role="status">
          <span>
            Loading dashboard data… {Math.floor(data.elapsed / 1000)}s ({data.total - data.pending}{" "}
            of {data.total} queries done)
          </span>
          <progress
            aria-label="Dashboard queries progress"
            value={data.total - data.pending}
            max={data.total}
          />
          <button type="button" onClick={() => void data.cancel()}>
            <CircleStop aria-hidden="true" /> Cancel queries
          </button>
        </div>
      )}
      {notice && (
        <p
          className={notice.tone === "error" ? "dash-error" : "dash-status"}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
      {dashboard.components.length ? (
        <GridCanvas layout={dashboard.layout} label={dashboard.name}>
          {dashboard.components.map((c) => (
            <GridItem key={c.id} id={c.id} placement={c.placement} label={c.title}>
              <section
                className={`dash-widget dash-${c.kind}`}
                aria-label={c.title || KIND_LABELS[c.kind]}
                style={minHeight(c)}
              >
                {c.title && c.kind !== "button" && c.kind !== "filter" && <h3>{c.title}</h3>}
                {body(c)}
              </section>
            </GridItem>
          ))}
        </GridCanvas>
      ) : (
        <p className="dash-muted">This dashboard has no components yet.</p>
      )}
      {dialog}
    </div>
  );
}
