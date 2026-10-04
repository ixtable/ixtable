/** Expression properties of a dashboard component: visibility, enabled state, table filter and styles. */
import { ExpressionField } from "../design/ExpressionField";
import { StylesEditor } from "../design/StylesEditor";
import type { DashboardComponent } from "./types";

/** Names a dashboard condition may use: the KPI scope (`params`, `app`). */
const DASHBOARD_NAMES = ["params", "app"];

/** Names a table row filter or style may use: one result row as `record`, plus `value`. */
const rowNames = (columns: string[], value = false) => [
  ...(columns.length ? columns.map((c) => `record.${c}`) : ["record"]),
  ...DASHBOARD_NAMES,
  ...(value ? ["value"] : []),
];

export function ConditionProperties({
  component,
  columns,
  change,
}: {
  component: DashboardComponent;
  columns: string[];
  change: (patch: Partial<DashboardComponent>, label?: string) => void;
}) {
  const c = component;
  return (
    <>
      {c.kind === "table" && (
        <>
          <ExpressionField
            label="Row filter"
            value={c.filter}
            names={rowNames(columns)}
            placeholder="record.amount > 0"
            onChange={(filter) => change({ filter }, "Edit table filter")}
          />
          <StylesEditor
            rules={c.styles}
            names={rowNames(columns, true)}
            columns={columns}
            onChange={(styles) => change({ styles }, "Edit conditional styles")}
          />
        </>
      )}
      <fieldset className="fd-fieldset">
        <legend>Behavior</legend>
        <ExpressionField
          label="Visible when"
          value={c.visibleWhen}
          names={DASHBOARD_NAMES}
          placeholder="params.region <> null"
          onChange={(visibleWhen) => change({ visibleWhen }, "Edit visibility")}
        />
        <ExpressionField
          label="Enabled when"
          value={c.enabledWhen}
          names={DASHBOARD_NAMES}
          placeholder="not isnull(params.region)"
          onChange={(enabledWhen) => change({ enabledWhen }, "Edit enabled condition")}
        />
      </fieldset>
    </>
  );
}
