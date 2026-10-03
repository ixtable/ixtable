import type { TableSchema } from "../../lib/types";
import { newId } from "../../lib/utils";
import { aliasFor, type BuilderJoin, type BuilderModel } from "./model";

export interface JoinSuggestion {
  table: string;
  leftSource: string;
  conditions: Array<{ leftColumn: string; rightColumn: string }>;
  label: string;
}

/** Joins implied by foreign keys between the model's sources and tables not yet in it. */
export function joinSuggestions(
  model: BuilderModel,
  schemas: Record<string, TableSchema>,
): JoinSuggestion[] {
  const used = new Set(model.sources.map((s) => s.table));
  const out: JoinSuggestion[] = [];
  const push = (table: string, leftSource: string, left: string[], right: string[]) => {
    const conditions = left.map((leftColumn, i) => ({ leftColumn, rightColumn: right[i] ?? "" }));
    const label = `Join ${table} on ${conditions
      .map((c) => `${leftSource}.${c.leftColumn} = ${table}.${c.rightColumn}`)
      .join(" and ")}`;
    if (!out.some((s) => s.label === label)) out.push({ table, leftSource, conditions, label });
  };
  for (const source of model.sources) {
    for (const fk of schemas[source.table]?.foreignKeys ?? [])
      if (!used.has(fk.targetTable))
        push(fk.targetTable, source.alias, fk.fromColumns, fk.targetColumns);
    for (const other of Object.values(schemas)) {
      if (used.has(other.name)) continue;
      for (const fk of other.foreignKeys)
        if (fk.targetTable === source.table)
          push(other.name, source.alias, fk.targetColumns, fk.fromColumns);
    }
  }
  return out;
}

/** Adds `table` as a joined source with the given conditions. */
export function addJoin(
  model: BuilderModel,
  table: string,
  leftSource: string,
  conditions: Array<{ leftColumn: string; rightColumn: string }>,
  kind: BuilderJoin["kind"] = "inner",
): BuilderModel {
  const alias = aliasFor(
    table,
    model.sources.map((s) => s.alias),
  );
  return {
    ...model,
    sources: [...model.sources, { id: newId(), table, alias }],
    joins: [
      ...model.joins,
      {
        id: newId(),
        kind,
        source: alias,
        conditions: conditions.map((c) => ({ leftSource, ...c })),
      },
    ],
  };
}

/** Removes a joined source and everything that refers to it. */
export function removeSource(model: BuilderModel, alias: string): BuilderModel {
  const keep = <T extends { source: string }>(items: T[]) =>
    items.filter((i) => i.source !== alias);
  const fields = keep(model.fields);
  const prune = (g: BuilderModel["filters"]): BuilderModel["filters"] => ({
    ...g,
    items: g.items
      .filter((i) => i.kind === "group" || i.source !== alias)
      .map((i) => (i.kind === "group" ? prune(i) : i)),
  });
  return {
    ...model,
    sources: model.sources.filter((s) => s.alias !== alias),
    joins: model.joins
      .filter((j) => j.source !== alias)
      .map((j) => ({ ...j, conditions: j.conditions.filter((c) => c.leftSource !== alias) })),
    fields,
    groupBy: keep(model.groupBy),
    filters: prune(model.filters),
    having: prune(model.having),
    orderBy: model.orderBy.filter((o) => fields.some((f) => f.id === o.fieldId)),
  };
}
