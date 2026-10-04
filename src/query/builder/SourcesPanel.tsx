import { Link2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { TableSchema } from "../../lib/types";
import { newId } from "../../lib/utils";
import { addJoin, joinSuggestions, removeSource } from "./joins";
import {
  aliasFor,
  type BuilderJoin,
  type BuilderModel,
  emptyModel,
  isEmptyModel,
  JOIN_KINDS,
  type JoinCondition,
  type JoinKind,
} from "./model";
import { columnsOf } from "./useSchemas";

export function SourcesPanel({
  model,
  tables,
  schemas,
  onChange,
}: {
  model: BuilderModel;
  tables: string[];
  schemas: Record<string, TableSchema>;
  onChange: (model: BuilderModel) => void;
}) {
  const [joinTable, setJoinTable] = useState("");
  const base = model.sources[0];
  const suggestions = joinSuggestions(model, schemas);
  const choose = (table: string) => {
    if (base?.table === table) return;
    if (
      !isEmptyModel(model) &&
      (model.fields.length || model.joins.length) &&
      !window.confirm("Changing the source table clears the fields, joins, and filters. Continue?")
    )
      return;
    onChange(
      table
        ? { ...emptyModel(), sources: [{ id: newId(), table, alias: aliasFor(table, []) }] }
        : emptyModel(),
    );
  };
  const patchJoin = (id: string, change: (j: BuilderJoin) => BuilderJoin) =>
    onChange({ ...model, joins: model.joins.map((j) => (j.id === id ? change(j) : j)) });
  return (
    <section className="query-panel" aria-labelledby="query-sources-heading">
      <h3 id="query-sources-heading">Sources</h3>
      <label className="query-row">
        <span>From</span>
        <select
          aria-label="Source table"
          value={base?.table ?? ""}
          onChange={(e) => choose(e.target.value)}
        >
          <option value="">Choose a table…</option>
          {tables.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {base && <code>AS {base.alias}</code>}
      </label>
      {model.joins.map((join) => {
        const source = model.sources.find((s) => s.alias === join.source);
        if (!source) return null;
        const index = model.sources.indexOf(source);
        const earlier = model.sources.slice(0, index);
        const blank = { leftSource: base?.alias ?? "", leftColumn: "", rightColumn: "" };
        const conditions = join.conditions.length ? join.conditions : [blank];
        const setCondition = (i: number, next: JoinCondition) =>
          patchJoin(join.id, (j) => ({
            ...j,
            conditions: conditions.map((c, k) => (k === i ? next : c)),
          }));
        // The first condition keeps the short labels; later ones are numbered.
        const n = (i: number) => (i ? ` ${i + 1}` : "");
        return (
          <div className="query-join" key={join.id}>
            <div className="query-row">
              <select
                aria-label={`Join type for ${source.alias}`}
                value={join.kind}
                onChange={(e) =>
                  patchJoin(join.id, (j) => ({ ...j, kind: e.target.value as JoinKind }))
                }
              >
                {JOIN_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
              <code>
                {source.table} AS {source.alias}
              </code>
              <button
                type="button"
                aria-label={`Remove join ${source.alias}`}
                onClick={() => onChange(removeSource(model, source.alias))}
              >
                <Trash2 />
              </button>
            </div>
            {conditions.map((condition, i) => (
              <div className="query-row" key={i}>
                <span>{i ? "and" : "on"}</span>
                <select
                  aria-label={`Join ${source.alias} left column${n(i)}`}
                  value={`${condition.leftSource}.${condition.leftColumn}`}
                  onChange={(e) => {
                    const [leftSource, ...rest] = e.target.value.split(".");
                    setCondition(i, { ...condition, leftSource, leftColumn: rest.join(".") });
                  }}
                >
                  <option value={`${condition.leftSource}.`}>Choose…</option>
                  {earlier.flatMap((s) =>
                    columnsOf(schemas, s.table).map((c) => (
                      <option key={`${s.alias}.${c}`} value={`${s.alias}.${c}`}>
                        {s.alias}.{c}
                      </option>
                    )),
                  )}
                </select>
                <span>=</span>
                <select
                  aria-label={`Join ${source.alias} right column${n(i)}`}
                  value={condition.rightColumn}
                  onChange={(e) => setCondition(i, { ...condition, rightColumn: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {columnsOf(schemas, source.table).map((c) => (
                    <option key={c} value={c}>
                      {source.alias}.{c}
                    </option>
                  ))}
                </select>
                {conditions.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove join ${source.alias} condition ${i + 1}`}
                    onClick={() =>
                      patchJoin(join.id, (j) => ({
                        ...j,
                        conditions: conditions.filter((_, k) => k !== i),
                      }))
                    }
                  >
                    <Trash2 />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                patchJoin(join.id, (j) => ({ ...j, conditions: [...conditions, blank] }))
              }
            >
              <Plus />
              Add condition to {source.alias}
            </button>
          </div>
        );
      })}
      {base && suggestions.length > 0 && (
        <div className="query-suggestions" aria-label="Suggested joins">
          {suggestions.map((s) => (
            <button
              type="button"
              key={s.label}
              onClick={() => onChange(addJoin(model, s.table, s.leftSource, s.conditions))}
            >
              <Link2 />
              {s.label}
            </button>
          ))}
        </div>
      )}
      {base && (
        <div className="query-row">
          <select
            aria-label="Join table"
            value={joinTable}
            onChange={(e) => setJoinTable(e.target.value)}
          >
            <option value="">Join another table…</option>
            {tables.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!joinTable}
            onClick={() => {
              onChange(
                addJoin(model, joinTable, base.alias, [{ leftColumn: "", rightColumn: "" }]),
              );
              setJoinTable("");
            }}
          >
            <Plus />
            Add join
          </button>
        </div>
      )}
    </section>
  );
}
