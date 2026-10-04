import { useEffect, useState } from "react";
import { kindForColumn } from "../design/generate";
import type { DesignControl, Relationship } from "../design/schema";
import { registerRecordHook } from "../lib/records";
import type { DataValue, TableSchema } from "../lib/types";
import { asTauriError, readTablePage } from "../lib/api";
import { runQuerySql, toDataValue } from "../query/api";
import { tableSchema } from "./data";
import { fromDataValue, type RecordValues } from "./values";

/** Column → the relationship whose display value is shown instead of the raw key. */
export type Lookups = Record<string, Relationship>;
/** Column → (key text → display text). */
export type LookupLabels = Record<string, Map<string, string>>;

const DISPLAY_NAMES = ["name", "title", "label"];
const labelCache = new Map<string, string | null>();
registerRecordHook({ after: () => labelCache.clear() });
if (typeof window !== "undefined")
  window.addEventListener("ixtable:database-changed", () => labelCache.clear());

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const cacheKey = (lookup: Relationship, key: string) =>
  JSON.stringify([lookup.table, lookup.valueColumn, lookup.displayColumn, key]);

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

/**
 * `[key, display]` rows read with one `in` filtered `read_table_page`, for a
 * runtime role (Rust refuses it ad hoc SQL but authorizes lookup table reads).
 */
async function labelsByKey(lookup: Relationship, keys: unknown[]) {
  const page = await readTablePage(lookup.table, {
    limit: keys.length,
    filters: [{ column: lookup.valueColumn, operator: "in", values: keys.map(toDataValue) }],
  });
  const at = (row: DataValue[], name: string) =>
    row[page.columns.findIndex((c) => c.name === name)];
  return {
    rows: page.rows.map((row) => [at(row, lookup.valueColumn), at(row, lookup.displayColumn)]),
  };
}

/** Display labels for the keys in `rows`: one bound `IN (...)` query per lookup, through DuckDB. */
export async function lookupLabels(lookups: Lookups, rows: RecordValues[]): Promise<LookupLabels> {
  const result: LookupLabels = {};
  await Promise.all(
    Object.entries(lookups).map(async ([column, lookup]) => {
      const labels = new Map<string, string>();
      const missing = new Map<string, unknown>();
      for (const row of rows) {
        const value = row[column];
        if (value == null || value === "") continue;
        const key = String(value);
        const hit = labelCache.get(cacheKey(lookup, key));
        if (hit !== undefined) {
          if (hit !== null) labels.set(key, hit);
        } else missing.set(key, value);
      }
      if (missing.size) {
        const params = Object.fromEntries([...missing.values()].map((v, i) => [`k${i}`, v]));
        const placeholders = Object.keys(params).map((name) => `$${name}`);
        const sql =
          `SELECT ${quote(lookup.valueColumn)} AS lookup_key, ${quote(lookup.displayColumn)} AS lookup_display ` +
          `FROM ${quote(lookup.table)} WHERE ${quote(lookup.valueColumn)} IN (${placeholders.join(", ")})`;
        const found = await runQuerySql(sql, params).catch((error) =>
          asTauriError(error).code === "FORBIDDEN"
            ? labelsByKey(lookup, [...missing.values()]).catch(() => null)
            : null,
        );
        for (const row of found?.rows ?? []) {
          const key = String(fromDataValue(row[0]));
          const display = fromDataValue(row[1]);
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
  return (column: string, value: unknown): string | undefined =>
    value == null ? undefined : labels[column]?.get(String(value));
}
