import { useEffect, useState } from "react";
import { kindForColumn } from "../design/generate";
import type { DesignControl, Relationship } from "../design/schema";
import { registerRecordHook } from "../lib/records";
import type { TableSchema } from "../lib/types";
import { runQuerySql } from "../query/api";
import { tableSchema } from "./data";
import { fromDataValue, type RecordValues } from "./values";

/** Column → the relationship whose display value is shown instead of the raw key. */
export type Lookups = Record<string, Relationship>;
/** Column → (key text, from `lookupKey`, → display text). */
export type LookupLabels = Record<string, Map<string, string>>;

const DISPLAY_NAMES = ["name", "title", "label"];
const labelCache = new Map<string, string | null>();
registerRecordHook({ after: () => labelCache.clear() });
if (typeof window !== "undefined")
  window.addEventListener("ixtable:database-changed", () => labelCache.clear());

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const cacheKey = (lookup: Relationship, key: string) =>
  JSON.stringify([lookup.table, lookup.valueColumn, lookup.displayColumn, lookup.keys, key]);

/** Key pairs of a multi-column relationship, else null. */
const compositeKeys = (lookup: Relationship) =>
  (lookup.keys?.length ?? 0) > 1 ? (lookup.keys ?? null) : null;

/**
 * The lookup key of `row` for `column`: the cell text, or for a multi-column relationship
 * every key column's text as JSON. Undefined when any key value is empty.
 */
export function lookupKey(lookup: Relationship, column: string, row: RecordValues) {
  const values = (compositeKeys(lookup) ?? [{ column }]).map((pair) => row[pair.column]);
  if (values.some((value) => value == null || value === "")) return undefined;
  return values.length > 1 ? JSON.stringify(values.map(String)) : String(values[0]);
}

/** Conventional display column: the first text column named name, title, or label. */
export function guessDisplayColumn(target: TableSchema): string | null {
  const column = target.columns.find(
    (c) => DISPLAY_NAMES.includes(c.name.toLowerCase()) && kindForColumn(c) === "text",
  );
  return column?.name ?? null;
}

/**
 * Lookups for list columns: a relationship control's display column wins; otherwise a
 * single-column foreign key of `table` with a conventional display column on its target.
 */
export async function columnLookups(
  table: string | null,
  columns: string[],
  controlFor: (column: string) => DesignControl | undefined,
): Promise<Lookups> {
  const schema = table ? await tableSchema(table).catch(() => null) : null;
  const entries = await Promise.all(
    columns.map(async (column): Promise<[string, Relationship] | null> => {
      const control = controlFor(column);
      const rel = control?.kind === "relationship" ? control.relationship : null;
      if (rel?.table && rel.valueColumn && rel.displayColumn)
        return rel.displayColumn === rel.valueColumn ? null : [column, rel];
      const fk = schema?.foreignKeys.find(
        (key) => key.fromColumns.length === 1 && key.fromColumns[0] === column,
      );
      if (!fk) return null;
      const target = await tableSchema(fk.targetTable).catch(() => null);
      const display = target && guessDisplayColumn(target);
      const valueColumn =
        fk.targetColumns[0] ?? target?.columns.find((c) => c.primaryKeyPosition === 1)?.name;
      if (!display || !valueColumn) return null;
      return [column, { table: fk.targetTable, valueColumn, displayColumn: display }];
    }),
  );
  return Object.fromEntries(entries.filter((e): e is [string, Relationship] => !!e));
}

/** Bound query reading display text for the keys of `rows` (one row per distinct key). */
function labelQuery(
  lookup: Relationship,
  column: string,
  rows: RecordValues[],
): [string, Record<string, unknown>] {
  const display = `${quote(lookup.displayColumn)} AS lookup_display`;
  const pairs = compositeKeys(lookup);
  if (!pairs) {
    const params = Object.fromEntries(rows.map((row, i) => [`k${i}`, row[column]]));
    const placeholders = Object.keys(params).map((name) => `$${name}`);
    return [
      `SELECT ${quote(lookup.valueColumn)} AS lookup_key, ${display} ` +
        `FROM ${quote(lookup.table)} WHERE ${quote(lookup.valueColumn)} IN (${placeholders.join(", ")})`,
      params,
    ];
  }
  const params: Record<string, unknown> = {};
  const matches = rows.map(
    (row, i) =>
      `(${pairs
        .map((pair, j) => {
          params[`k${i}_${j}`] = row[pair.column];
          return `${quote(pair.target)} = $k${i}_${j}`;
        })
        .join(" AND ")})`,
  );
  const keys = pairs.map((pair, j) => `${quote(pair.target)} AS lookup_key${j}`).join(", ");
  return [
    `SELECT ${keys}, ${display} FROM ${quote(lookup.table)} WHERE ${matches.join(" OR ")}`,
    params,
  ];
}

/** Display labels for the keys in `rows`: one bound `IN (...)` query per lookup, through DuckDB. */
export async function lookupLabels(lookups: Lookups, rows: RecordValues[]): Promise<LookupLabels> {
  const result: LookupLabels = {};
  await Promise.all(
    Object.entries(lookups).map(async ([column, lookup]) => {
      const labels = new Map<string, string>();
      const missing = new Map<string, RecordValues>();
      const pairs = compositeKeys(lookup);
      for (const row of rows) {
        const key = lookupKey(lookup, column, row);
        if (key === undefined) continue;
        const hit = labelCache.get(cacheKey(lookup, key));
        if (hit !== undefined) {
          if (hit !== null) labels.set(key, hit);
        } else missing.set(key, row);
      }
      if (missing.size) {
        const found = await runQuerySql(
          ...labelQuery(lookup, column, [...missing.values()]),
        ).catch(() => null);
        for (const row of found?.rows ?? []) {
          const values = row.slice(0, pairs?.length ?? 1).map((v) => String(fromDataValue(v)));
          const key = pairs ? JSON.stringify(values) : values[0];
          const display = fromDataValue(row[row.length - 1]);
          const text = display == null ? null : String(display);
          labelCache.set(cacheKey(lookup, key), text);
          if (text !== null) labels.set(key, text);
          missing.delete(key);
        }
        if (found) for (const key of missing.keys()) labelCache.set(cacheKey(lookup, key), null);
      }
      result[column] = labels;
    }),
  );
  return result;
}

/**
 * Display values for relationship columns of `rows`. Returns a function giving the label
 * for a cell, or undefined when the column has no lookup (or the key has no label yet).
 */
export function useLookupLabels(
  table: string | null,
  columns: string[],
  controlFor: (column: string) => DesignControl | undefined,
  rows: RecordValues[] | undefined,
) {
  const [lookups, setLookups] = useState<Lookups>({});
  const [labels, setLabels] = useState<LookupLabels>({});
  // What the lookups depend on, as a stable string: columns and their relationship controls.
  const signature = JSON.stringify(
    columns.map((column) => {
      const control = controlFor(column);
      return [column, control?.kind === "relationship" ? (control.relationship ?? null) : null];
    }),
  );
  useEffect(() => {
    let live = true;
    const entries = JSON.parse(signature) as [string, Relationship | null][];
    const relationships = new Map(entries);
    columnLookups(
      table,
      entries.map(([column]) => column),
      (column) => {
        const relationship = relationships.get(column);
        return relationship ? ({ kind: "relationship", relationship } as DesignControl) : undefined;
      },
    )
      .then((next) => live && setLookups(next))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [table, signature]);
  useEffect(() => {
    let live = true;
    if (!rows?.length || !Object.keys(lookups).length) {
      setLabels({});
      return;
    }
    lookupLabels(lookups, rows)
      .then((next) => live && setLabels(next))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [lookups, rows]);
  return (column: string, row: RecordValues): string | undefined => {
    const lookup = lookups[column];
    const key = lookup && lookupKey(lookup, column, row);
    return key === undefined ? undefined : labels[column]?.get(key);
  };
}
