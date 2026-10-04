import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { TableSchema } from "../../lib/types";
import type { BuilderModel } from "./model";
import { columnsOf } from "./useSchemas";

/**
 * Explicit GROUP BY columns. Output fields without an aggregate are grouped automatically,
 * so this lists only the extra columns, which need not be output.
 */
export function GroupByPanel({
  model,
  schemas,
  onChange,
}: {
  model: BuilderModel;
  schemas: Record<string, TableSchema>;
  onChange: (model: BuilderModel) => void;
}) {
  const [choice, setChoice] = useState("");
  const key = (g: { source: string; column: string }) => `${g.source}.${g.column}`;
  const used = new Set(model.groupBy.map(key));
  const options = model.sources.flatMap((s) =>
    columnsOf(schemas, s.table)
      .map((column) => ({ source: s.alias, column }))
      .filter((g) => !used.has(key(g))),
  );
  return (
    <section className="query-panel" aria-labelledby="query-group-heading">
      <h3 id="query-group-heading">Group by</h3>
      <ul aria-label="Group by columns">
        {model.groupBy.map((g) => (
          <li key={key(g)} className="query-row">
            <span>{key(g)}</span>
            <button
              type="button"
              aria-label={`Remove group by ${key(g)}`}
              onClick={() =>
                onChange({ ...model, groupBy: model.groupBy.filter((x) => key(x) !== key(g)) })
              }
            >
              <Trash2 />
            </button>
          </li>
        ))}
      </ul>
      <div className="query-row">
        <select
          aria-label="Group by column"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">Choose a column…</option>
          {options.map((g) => (
            <option key={key(g)} value={key(g)}>
              {key(g)}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!choice}
          onClick={() => {
            const g = options.find((o) => key(o) === choice);
            if (g) onChange({ ...model, groupBy: [...model.groupBy, g] });
            setChoice("");
          }}
        >
          <Plus />
          Add group by
        </button>
      </div>
    </section>
  );
}
