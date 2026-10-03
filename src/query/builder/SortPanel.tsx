import { ArrowDownUp, Trash2 } from "lucide-react";
import { newId } from "../../lib/utils";
import { type BuilderModel, type BuilderSort, fieldName } from "./model";

/** ORDER BY over chosen fields, plus the optional row limit. */
export function SortPanel({
  model,
  onChange,
}: {
  model: BuilderModel;
  onChange: (model: BuilderModel) => void;
}) {
  const patch = (id: string, change: Partial<BuilderSort>) =>
    onChange({
      ...model,
      orderBy: model.orderBy.map((o) => (o.id === id ? { ...o, ...change } : o)),
    });
  return (
    <section className="query-panel" aria-labelledby="query-sort-heading">
      <h3 id="query-sort-heading">Sort and limit</h3>
      {model.orderBy.map((o, i) => (
        <div className="query-row" key={o.id}>
          <select
            aria-label={`Sort ${i + 1} field`}
            value={o.fieldId}
            onChange={(e) => patch(o.id, { fieldId: e.target.value })}
          >
            {model.fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.aggregate ? `${f.aggregate}(${fieldName(f)})` : fieldName(f)}
              </option>
            ))}
          </select>
          <select
            aria-label={`Sort ${i + 1} direction`}
            value={o.direction}
            onChange={(e) => patch(o.id, { direction: e.target.value as BuilderSort["direction"] })}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button
            type="button"
            aria-label={`Remove sort ${i + 1}`}
            onClick={() =>
              onChange({ ...model, orderBy: model.orderBy.filter((x) => x.id !== o.id) })
            }
          >
            <Trash2 />
          </button>
        </div>
      ))}
      <div className="query-row">
        <button
          type="button"
          disabled={!model.fields.length}
          onClick={() =>
            onChange({
              ...model,
              orderBy: [
                ...model.orderBy,
                { id: newId(), fieldId: model.fields[0].id, direction: "asc" },
              ],
            })
          }
        >
          <ArrowDownUp />
          Add sort
        </button>
        <label>
          <span>Limit</span>
          <input
            aria-label="Row limit"
            type="number"
            min={0}
            step={1}
            placeholder="All rows"
            value={model.limit ?? ""}
            onChange={(e) =>
              onChange({
                ...model,
                limit:
                  e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value))),
              })
            }
          />
        </label>
      </div>
    </section>
  );
}
