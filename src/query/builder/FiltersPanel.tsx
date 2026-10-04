import { FolderPlus, Plus, Trash2 } from "lucide-react";
import type { TableSchema } from "../../lib/types";
import { newId } from "../../lib/utils";
import type { QueryParameter } from "../types";
import {
  AGGREGATES,
  type Aggregate,
  type BuilderCondition,
  type BuilderGroup,
  type BuilderModel,
  emptyGroup,
  FILTER_OPERATORS,
  type FilterOperator,
  unaryOperator,
} from "./model";
import { columnsOf } from "./useSchemas";

type Item = BuilderCondition | BuilderGroup;

const NUMERIC = /INT|REAL|FLOA|DOUB|NUM|DEC/i;

function GroupEditor({
  group,
  path,
  having,
  model,
  schemas,
  parameters,
  onChange,
  onRemove,
}: {
  group: BuilderGroup;
  /** "" for the top-level group, else e.g. "group 1". */
  path: string;
  having: boolean;
  model: BuilderModel;
  schemas: Record<string, TableSchema>;
  parameters: QueryParameter[];
  onChange: (group: BuilderGroup) => void;
  onRemove?: () => void;
}) {
  const columns = model.sources.flatMap((s) =>
    columnsOf(schemas, s.table).map((c) => ({
      value: `${s.alias}.${c}`,
      numeric: NUMERIC.test(
        schemas[s.table]?.columns.find((x) => x.name === c)?.declaredType ?? "",
      ),
    })),
  );
  const setItem = (index: number, item: Item) =>
    onChange({ ...group, items: group.items.map((x, i) => (i === index ? item : x)) });
  const removeItem = (index: number) =>
    onChange({ ...group, items: group.items.filter((_, i) => i !== index) });
  const base = model.sources[0];
  const newCondition = (): BuilderCondition => {
    const [source, ...rest] = (columns[0]?.value ?? `${base?.alias ?? ""}.`).split(".");
    return {
      id: newId(),
      kind: "condition",
      source,
      column: rest.join("."),
      aggregate: having ? "sum" : null,
      operator: "=",
      value: { kind: "value", value: "" },
    };
  };
  const scope = having ? "Having" : "Filter";
  const noun = having ? "condition" : "filter";
  const where = path ? `${scope} ${path}` : scope;
  const conditionIds = group.items.flatMap((i) => (i.kind === "condition" ? [i.id] : []));
  return (
    <div className="query-group" role="group" aria-label={where}>
      <label className="query-row">
        <span>Match</span>
        <select
          aria-label={`${where} match`}
          value={group.combinator}
          onChange={(e) => onChange({ ...group, combinator: e.target.value as "and" | "or" })}
        >
          <option value="and">all</option>
          <option value="or">any</option>
        </select>
        {onRemove && (
          <button type="button" aria-label={`Remove ${where}`} onClick={onRemove}>
            <Trash2 />
          </button>
        )}
      </label>
      {group.items.map((item, index) => {
        if (item.kind === "group")
          return (
            <GroupEditor
              key={item.id}
              group={item}
              path={path ? `${path} group ${index + 1}` : `group ${index + 1}`}
              having={having}
              model={model}
              schemas={schemas}
              parameters={parameters}
              onChange={(g) => setItem(index, g)}
              onRemove={() => removeItem(index)}
            />
          );
        const n = conditionIds.indexOf(item.id) + 1;
        const label = path ? `${where} ${noun} ${n}` : `${scope} ${n}`;
        const column = columns.find((c) => c.value === `${item.source}.${item.column}`);
        const value = item.value ?? { kind: "value" as const, value: "" };
        const patch = (change: Partial<BuilderCondition>) => setItem(index, { ...item, ...change });
        return (
          <div className="query-row" key={item.id} role="group" aria-label={label}>
            {having && (
              <select
                aria-label={`${label} aggregate`}
                value={item.aggregate ?? ""}
                onChange={(e) => patch({ aggregate: (e.target.value || null) as Aggregate | null })}
              >
                <option value="">Value</option>
                {AGGREGATES.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label={`${label} column`}
              value={`${item.source}.${item.column}`}
              onChange={(e) => {
                const [source, ...rest] = e.target.value.split(".");
                patch({ source, column: rest.join(".") });
              }}
            >
              {columns.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.value}
                </option>
              ))}
            </select>
            <select
              aria-label={`${label} operator`}
              value={item.operator}
              onChange={(e) => patch({ operator: e.target.value as FilterOperator })}
            >
              {FILTER_OPERATORS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {!unaryOperator(item.operator) && (
              <>
                <select
                  aria-label={`${label} compares with`}
                  value={value.kind}
                  onChange={(e) =>
                    patch({
                      value:
                        e.target.value === "param"
                          ? { kind: "param", name: parameters[0]?.name ?? "" }
                          : { kind: "value", value: "" },
                    })
                  }
                >
                  <option value="value">Value</option>
                  <option value="param">Parameter</option>
                </select>
                {value.kind === "param" ? (
                  <select
                    aria-label={`${label} parameter`}
                    value={value.name}
                    onChange={(e) => patch({ value: { kind: "param", name: e.target.value } })}
                  >
                    <option value="">Choose a parameter…</option>
                    {parameters.map((p) => (
                      <option key={p.name} value={p.name}>
                        ${p.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label={`${label} value`}
                    value={value.value === null ? "" : String(value.value)}
                    onChange={(e) => {
                      const text = e.target.value;
                      const numeric =
                        (column?.numeric || !!item.aggregate) &&
                        text.trim() !== "" &&
                        Number.isFinite(Number(text));
                      patch({ value: { kind: "value", value: numeric ? Number(text) : text } });
                    }}
                  />
                )}
              </>
            )}
            <button type="button" aria-label={`Remove ${label}`} onClick={() => removeItem(index)}>
              <Trash2 />
            </button>
          </div>
        );
      })}
      <div className="query-row">
        <button
          type="button"
          disabled={!base}
          onClick={() => onChange({ ...group, items: [...group.items, newCondition()] })}
        >
          <Plus />
          {path ? `Add ${noun} to ${path}` : `Add ${noun}`}
        </button>
        <button
          type="button"
          disabled={!base}
          onClick={() => onChange({ ...group, items: [...group.items, emptyGroup()] })}
        >
          <FolderPlus />
          {path ? `Add group to ${path}` : `Add ${noun} group`}
        </button>
      </div>
    </div>
  );
}

/** WHERE filters (`having` false) or HAVING conditions over aggregates (`having` true). */
export function FiltersPanel({
  model,
  schemas,
  parameters,
  having,
  onChange,
}: {
  model: BuilderModel;
  schemas: Record<string, TableSchema>;
  parameters: QueryParameter[];
  having?: boolean;
  onChange: (model: BuilderModel) => void;
}) {
  const key = having ? "having" : "filters";
  const title = having ? "Having" : "Filters";
  return (
    <section className="query-panel" aria-labelledby={`query-${key}-heading`}>
      <h3 id={`query-${key}-heading`}>{title}</h3>
      <GroupEditor
        group={model[key]}
        path=""
        having={!!having}
        model={model}
        schemas={schemas}
        parameters={parameters}
        onChange={(group) => onChange({ ...model, [key]: group })}
      />
    </section>
  );
}
