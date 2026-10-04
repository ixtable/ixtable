import { ArrowDown, ArrowUp, Hash, Plus, Trash2 } from "lucide-react";
import type { TableSchema } from "../../lib/types";
import { newId } from "../../lib/utils";
import { fieldLabel } from "./compile";
import {
  AGGREGATES,
  type Aggregate,
  type BuilderField,
  type BuilderModel,
  fieldName,
} from "./model";
import { columnsOf } from "./useSchemas";

/** Column checkboxes per source, then alias / aggregate / order for chosen fields. */
export function FieldsPanel({
  model,
  schemas,
  onChange,
}: {
  model: BuilderModel;
  schemas: Record<string, TableSchema>;
  onChange: (model: BuilderModel) => void;
}) {
  const find = (source: string, column: string) =>
    model.fields.find((f) => f.source === source && f.column === column);
  const toggle = (source: string, column: string, checked: boolean) => {
    const existing = find(source, column);
    if (checked && !existing)
      onChange({
        ...model,
        fields: [...model.fields, { id: newId(), source, column, selected: true }],
      });
    else if (!checked && existing) removeField(existing.id);
  };
  const removeField = (id: string) =>
    onChange({
      ...model,
      fields: model.fields.filter((f) => f.id !== id),
      orderBy: model.orderBy.filter((o) => o.fieldId !== id),
    });
  const patch = (id: string, change: Partial<BuilderField>) =>
    onChange({
      ...model,
      fields: model.fields.map((f) => (f.id === id ? { ...f, ...change } : f)),
    });
  const move = (index: number, step: number) => {
    const fields = [...model.fields];
    const [field] = fields.splice(index, 1);
    fields.splice(index + step, 0, field);
    onChange({ ...model, fields });
  };
  const base = model.sources[0];
  return (
    <section className="query-panel" aria-labelledby="query-fields-heading">
      <h3 id="query-fields-heading">Fields</h3>
      <div className="query-columns">
        {model.sources.map((s) => (
          <fieldset key={s.id}>
            <legend>
              {s.table} ({s.alias})
            </legend>
            {columnsOf(schemas, s.table).map((c) => (
              <label key={c} className="query-check">
                <input
                  type="checkbox"
                  checked={!!find(s.alias, c)}
                  onChange={(e) => toggle(s.alias, c, e.target.checked)}
                />
                {s.alias}.{c}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      {base && (
        <button
          type="button"
          onClick={() =>
            onChange({
              ...model,
              fields: [
                ...model.fields,
                {
                  id: newId(),
                  source: base.alias,
                  column: "*",
                  aggregate: "count",
                  selected: true,
                },
              ],
            })
          }
        >
          <Hash />
          Add row count
        </button>
      )}
      {model.fields.length > 0 && (
        <ol className="query-field-list" aria-label="Selected fields">
          {model.fields.map((f, i) => {
            const name = fieldName(f);
            return (
              <li key={f.id} className="query-row">
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Output ${name}`}
                    checked={f.selected}
                    onChange={(e) => patch(f.id, { selected: e.target.checked })}
                  />
                  <span className={f.selected ? "" : "text-slate-500"}>{name}</span>
                </label>
                <select
                  aria-label={`Aggregate for ${name}`}
                  value={f.aggregate ?? ""}
                  onChange={(e) =>
                    patch(f.id, { aggregate: (e.target.value || null) as Aggregate | null })
                  }
                >
                  {f.column !== "*" && <option value="">Value (group by)</option>}
                  {AGGREGATES.filter((a) => f.column !== "*" || a.id === "count").map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Alias for ${name}`}
                  placeholder={fieldLabel({ ...f, alias: "" })}
                  value={f.alias ?? ""}
                  onChange={(e) => patch(f.id, { alias: e.target.value })}
                />
                <button
                  type="button"
                  aria-label={`Move ${name} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${name} down`}
                  disabled={i === model.fields.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown />
                </button>
                <button
                  type="button"
                  aria-label={`Remove field ${name}`}
                  onClick={() => removeField(f.id)}
                >
                  <Trash2 />
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {!model.fields.length && base && (
        <small>
          <Plus /> No fields chosen: every column is returned.
        </small>
      )}
    </section>
  );
}
