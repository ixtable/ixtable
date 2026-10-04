/** Properties of the selected dashboard component. Field pickers list the query's result columns. */
import { RegionPicker } from "../design/RegionEditor";
import { Trash2 } from "lucide-react";
import { type ReactNode, useId } from "react";
import { ActionPicker } from "../automation/ActionPicker";
import { FORM_MODES, type FormMode } from "../design/schema";
import { check } from "../expr";
import { useDocumentConfig } from "../lib/config-store";
import { QueryPicker } from "../query/QueryPicker";
import { CHART_LABELS, KIND_LABELS } from "./model";
import { useQueryColumns } from "./useQueryColumns";
import { CHART_TYPES, type ChartType, type Dashboard, type DashboardComponent } from "./types";

type Change = (patch: Partial<DashboardComponent>, label?: string) => void;

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="dash-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

function ColumnSelect({
  label,
  value,
  columns,
  onChange,
  none = "(none)",
}: {
  label: string;
  value: string | null | undefined;
  columns: string[];
  onChange: (value: string | null) => void;
  none?: string;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{none}</option>
          {value && !columns.includes(value) && <option value={value}>{value}</option>}
          {columns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function ColumnChecks({
  legend,
  selected,
  columns,
  onChange,
}: {
  legend: string;
  selected: string[];
  columns: string[];
  onChange: (value: string[]) => void;
}) {
  const all = [...columns, ...selected.filter((c) => !columns.includes(c))];
  return (
    <fieldset className="fd-fieldset">
      <legend>{legend}</legend>
      {!all.length && <p className="fd-hint">Choose a query to list its columns.</p>}
      {all.map((c) => (
        <label key={c} className="fd-check">
          <input
            type="checkbox"
            checked={selected.includes(c)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? all.filter((x) => x === c || selected.includes(x))
                  : selected.filter((x) => x !== c),
              )
            }
          />
          {c}
        </label>
      ))}
    </fieldset>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  code,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  placeholder?: string;
  code?: boolean;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <input
          id={id}
          className={code ? "fd-code" : undefined}
          spellCheck={code ? false : undefined}
          placeholder={placeholder}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        />
      )}
    </Field>
  );
}

/** Expression over `rows`, `params` and `app`, checked as you type. */
function ExpressionInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
}) {
  const id = useId();
  const problem = value?.trim()
    ? check(value, ["rows", "params", "app"])
        .map((d) => d.message)
        .join("; ")
    : "";
  return (
    <div className="dash-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="fd-code"
        spellCheck={false}
        placeholder="sum(rows.amount)"
        value={value ?? ""}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      />
      {problem && (
        <small id={`${id}-problem`} className="fd-problem" role="status">
          {problem}
        </small>
      )}
    </div>
  );
}

export function ComponentProperties({
  dashboard,
  component,
  params,
  change,
  remove,
}: {
  dashboard: Dashboard;
  component: DashboardComponent;
  params: Record<string, unknown>;
  change: Change;
  remove: () => void;
}) {
  const { config } = useDocumentConfig();
  const usesQuery = ["kpi", "table", "chart"].includes(component.kind);
  const discovered = useQueryColumns(usesQuery ? component.queryId : null, params);
  const columns = discovered.columns;
  const c = component;
  return (
    <>
      <small>{KIND_LABELS[c.kind].toUpperCase()} PROPERTIES</small>
      <TextField
        label="Title"
        value={c.title}
        onChange={(v) => change({ title: v ?? "" }, "Rename component")}
      />
      {usesQuery && (
        <>
          <QueryPicker
            value={c.queryId}
            onChange={(id) => change({ queryId: id || null }, "Set component query")}
          />
          {discovered.error && (
            <p className="fd-problem" role="status">
              Could not read the query's columns: {discovered.error}
            </p>
          )}
        </>
      )}
      {c.kind === "kpi" && (
        <>
          <ColumnSelect
            label="Value field"
            value={c.valueField}
            columns={columns}
            onChange={(v) => change({ valueField: v })}
          />
          <ExpressionInput
            label="Value expression"
            value={c.expression}
            onChange={(v) => change({ expression: v })}
          />
          <TextField
            label="Format"
            placeholder="#,##0.00"
            value={c.format}
            onChange={(v) => change({ format: v })}
            code
          />
          <fieldset className="fd-fieldset">
            <legend>Comparison</legend>
            <ColumnSelect
              label="Comparison field"
              value={c.comparison?.valueField}
              columns={columns}
              onChange={(v) =>
                change({
                  comparison:
                    v || c.comparison?.expression
                      ? { label: "", ...c.comparison, valueField: v }
                      : null,
                })
              }
            />
            <ExpressionInput
              label="Comparison expression"
              value={c.comparison?.expression}
              onChange={(v) =>
                change({
                  comparison:
                    v || c.comparison?.valueField
                      ? { label: "", ...c.comparison, expression: v }
                      : null,
                })
              }
            />
            <TextField
              label="Comparison label"
              placeholder="target"
              value={c.comparison?.label}
              onChange={(v) => change({ comparison: { ...c.comparison, label: v ?? "" } })}
            />
          </fieldset>
        </>
      )}
      {c.kind === "chart" && (
        <>
          <Field label="Chart type">
            {(id) => (
              <select
                id={id}
                value={c.chartType ?? "bar"}
                onChange={(e) =>
                  change({ chartType: e.target.value as ChartType }, "Set chart type")
                }
              >
                {CHART_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CHART_LABELS[t]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <ColumnSelect
            label={c.chartType === "scatter" ? "X field (number)" : "X field"}
            value={c.x}
            columns={columns}
            onChange={(v) => change({ x: v })}
          />
          <ColumnChecks
            legend="Value fields"
            selected={c.y ?? []}
            columns={columns}
            onChange={(y) => change({ y })}
          />
          <ColumnSelect
            label="Group by"
            value={c.groupBy}
            columns={columns}
            onChange={(v) => change({ groupBy: v })}
          />
          {(c.chartType === "bar" || c.chartType === "area") && (
            <label className="fd-check">
              <input
                type="checkbox"
                checked={!!c.stacked}
                onChange={(e) => change({ stacked: e.target.checked })}
              />
              Stacked
            </label>
          )}
          <TextField
            label="Format"
            placeholder="#,##0"
            value={c.format}
            onChange={(v) => change({ format: v })}
            code
          />
        </>
      )}
      {c.kind === "table" && (
        <>
          <ColumnChecks
            legend="Columns"
            selected={c.columns ?? []}
            columns={columns}
            onChange={(v) => change({ columns: v })}
          />
          <Field label="Page size">
            {(id) => (
              <input
                id={id}
                type="number"
                min={1}
                value={c.pageSize ?? 10}
                onChange={(e) =>
                  change({ pageSize: Math.max(1, Math.round(Number(e.target.value) || 1)) })
                }
              />
            )}
          </Field>
        </>
      )}
      {c.kind === "filter" && (
        <Field label="Filter">
          {(id) => (
            <select
              id={id}
              value={c.filterId ?? ""}
              onChange={(e) => change({ filterId: e.target.value || null })}
            >
              <option value="">(none)</option>
              {dashboard.filters.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name || f.param}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      {c.kind === "form" && (
        <>
          <Field label="Form">
            {(id) => (
              <select
                id={id}
                value={c.formId ?? ""}
                onChange={(e) => change({ formId: e.target.value || null })}
              >
                <option value="">(none)</option>
                {(config.design?.forms ?? []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Form mode">
            {(id) => (
              <select
                id={id}
                value={c.mode ?? "list"}
                onChange={(e) => change({ mode: e.target.value as FormMode })}
              >
                {FORM_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </>
      )}
      {c.kind === "report" && (
        <Field label="Report">
          {(id) => (
            <select
              id={id}
              value={c.reportId ?? ""}
              onChange={(e) => change({ reportId: e.target.value || null })}
            >
              <option value="">(none)</option>
              {config.reports.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      {c.kind === "button" && (
        <>
          <TextField label="Button label" value={c.label} onChange={(v) => change({ label: v })} />
          <ActionPicker value={c.actionId} onChange={(v) => change({ actionId: v })} />
        </>
      )}
      {c.kind === "text" && (
        <Field label="Text">
          {(id) => (
            <textarea
              id={id}
              rows={5}
              value={c.text ?? ""}
              onChange={(e) => change({ text: e.target.value })}
            />
          )}
        </Field>
      )}
      <p className="fd-hint">
        Column {c.placement.column}, row {c.placement.row}, {c.placement.columnSpan} ×{" "}
        {c.placement.rowSpan}. Alt+Arrow resizes, Alt+Shift+Arrow moves.
      </p>
      <RegionPicker
        layout={dashboard.layout}
        placement={c.placement}
        onChange={(placement) => change({ placement }, "Place component")}
      />
      <button type="button" onClick={remove}>
        <Trash2 aria-hidden="true" /> Delete component
      </button>
    </>
  );
}
