/** Live dashboard components. Each reuses an existing primitive (result grid, expressions, actions). */
import { useEffect, useId, useState } from "react";
import { ResultGrid } from "../data/ResultGrid";
import type { QueryResult } from "../lib/types";
import { runSavedQuery } from "../query/api";
import { Chart } from "./charts/Chart";
import { rowFilter, toneClass, toneFor } from "../runtime/conditions";
import { type DateRange, type FilterValue, kpiValue, type Row, resultRows } from "./data";
import type { DashboardComponent, DashboardFilter } from "./types";
import type { QueryState } from "./useDashboardData";

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** Loading, error and empty states shared by query-backed components. */
export function QueryGate({
  component,
  state,
  children,
}: {
  component: DashboardComponent;
  state: QueryState | undefined;
  children: (result: QueryResult) => React.ReactNode;
}) {
  if (!component.queryId)
    return <p className="dash-muted">Choose a saved query for this component.</p>;
  if (state?.status === "denied")
    return (
      <p className="dash-error" role="alert">
        You do not have access to this data.
      </p>
    );
  if (!state || (state.status === "loading" && !state.result))
    return <p className="dash-muted">Loading…</p>;
  if (state.status === "error" || state.status === "cancelled")
    return (
      <p
        className={state.status === "error" ? "dash-error" : "dash-muted"}
        role={state.status === "error" ? "alert" : "status"}
      >
        {state.error}
      </p>
    );
  if (!("result" in state) || !state.result) return <p className="dash-muted">Loading…</p>;
  return <div aria-busy={state.status === "loading"}>{children(state.result)}</div>;
}

export function KpiBody({
  component,
  rows,
  scope,
}: {
  component: DashboardComponent;
  rows: Row[];
  scope: Record<string, unknown>;
}) {
  let kpi: ReturnType<typeof kpiValue>;
  try {
    kpi = kpiValue(component, rows, scope);
  } catch (reason) {
    return (
      <p className="dash-error" role="alert">
        {message(reason)}
      </p>
    );
  }
  const up = (kpi.comparison?.delta ?? 0) >= 0;
  return (
    <div className="dash-kpi">
      <p className="dash-kpi-value">{kpi.text}</p>
      {kpi.comparison && (
        <p className="dash-kpi-compare">
          <span aria-hidden="true">{kpi.comparison.delta === null ? "" : up ? "▲ " : "▼ "}</span>
          {kpi.comparison.text} vs {kpi.comparison.label}
        </p>
      )}
    </div>
  );
}

/**
 * Table component. The `filter` expression keeps result rows (`record` is one row); paging
 * counts only kept rows, which is exact because the whole query result is loaded. Cells take
 * the tone of the first matching `styles` rule for their column.
 */
export function TableBody({
  component,
  result,
  scope = {},
}: {
  component: DashboardComponent;
  result: QueryResult;
  scope?: Record<string, unknown>;
}) {
  const [page, setPage] = useState(0);
  const size = Math.max(1, component.pageSize ?? 10);
  const shown = (component.columns ?? []).filter((c) => result.columns.includes(c));
  const indexes = shown.length
    ? shown.map((c) => result.columns.indexOf(c))
    : result.columns.map((_, i) => i);
  const records = resultRows(result);
  let keep: ReturnType<typeof rowFilter> = null;
  try {
    keep = rowFilter(component.filter, { form: {}, parent: null, ...scope });
  } catch (reason) {
    return (
      <p className="dash-error" role="alert">
        Filter: {message(reason)}
      </p>
    );
  }
  const kept = records.flatMap((record, i) => (!keep || keep(record) ? [i] : []));
  const pages = Math.max(1, Math.ceil(kept.length / size));
  const current = Math.min(page, pages - 1);
  const rows = kept.slice(current * size, current * size + size);
  const slice: QueryResult = {
    columns: indexes.map((i) => result.columns[i]),
    rows: rows.map((r) => indexes.map((i) => result.rows[r][i])),
  };
  const cellClass = component.styles?.length
    ? (row: number, column: number) => {
        const record = records[rows[row]];
        const name = slice.columns[column];
        const tone = toneFor(component.styles, { ...scope, record, value: record[name] }, name);
        return toneClass(tone) || undefined;
      }
    : undefined;
  const name = component.title || "Table";
  return (
    <div className="dash-table">
      <ResultGrid result={slice} cellClass={cellClass} />
      {pages > 1 && (
        <div className="dash-pager">
          <button
            type="button"
            aria-label={`${name} previous page`}
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            Previous
          </button>
          <span>
            Page {current + 1} of {pages}
          </span>
          <button
            type="button"
            aria-label={`${name} next page`}
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

export function ChartBody({ component, rows }: { component: DashboardComponent; rows: Row[] }) {
  return (
    <Chart
      spec={{ ...component, chartType: component.chartType ?? "bar" }}
      title={component.title}
      rows={rows}
    />
  );
}

/** Choices for a select filter: fixed options, else the first column of its options query. */
function useFilterOptions(filter: DashboardFilter) {
  const [loaded, setLoaded] = useState<string[]>([]);
  const queryId =
    filter.control === "select" && !filter.options?.length ? filter.optionsQueryId : null;
  useEffect(() => {
    if (!queryId) return;
    let live = true;
    runSavedQuery(queryId, {}, { limit: 500 })
      .then((result) => {
        const values = result.rows
          .map((row) => row[0]?.value)
          .filter((v) => v !== undefined && v !== null);
        if (live) setLoaded([...new Set(values.map(String))]);
      })
      .catch(() => live && setLoaded([]));
    return () => {
      live = false;
    };
  }, [queryId]);
  return filter.options?.length ? filter.options : loaded;
}

/** One dashboard filter as a labelled control. Blank means "all" (the query default). */
export function FilterInput({
  filter,
  value,
  onChange,
}: {
  filter: DashboardFilter;
  value: FilterValue;
  onChange: (value: FilterValue) => void;
}) {
  const id = useId();
  const options = useFilterOptions(filter);
  const label = filter.name || filter.param;
  if (filter.control === "dateRange") {
    const range = (value ?? {}) as DateRange;
    return (
      <fieldset className="dash-filter dash-range">
        <legend>{label}</legend>
        <label>
          From
          <input
            type="date"
            value={range.from ?? ""}
            onChange={(e) => onChange({ ...range, from: e.target.value })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={range.to ?? ""}
            onChange={(e) => onChange({ ...range, to: e.target.value })}
          />
        </label>
      </fieldset>
    );
  }
  const text = value === null || value === undefined ? "" : String(value);
  return (
    <div className="dash-filter">
      <label htmlFor={id}>{label}</label>
      {filter.control === "select" ? (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">All</option>
          {text && !options.includes(text) && <option value={text}>{text}</option>}
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={
            filter.control === "number" ? "number" : filter.control === "date" ? "date" : "search"
          }
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

export function TextBody({ text }: { text: string }) {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  return (
    <div className="dash-text">
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}
