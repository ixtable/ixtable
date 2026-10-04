import { runQuery } from "../automation/runner";
import { runSavedQueryPage } from "../query/api";
import type { DesignForm, Relationship } from "../design/schema";
import { evaluate } from "../expr";
import { inspectTable, readTablePage } from "../lib/api";
import { registerRecordHook } from "../lib/records";
import type { DataValue, DocumentConfig, Filter, Sort, TableSchema } from "../lib/types";
import { fromDataValue, type RecordValues, rowObject } from "./values";

/** One page of records for a list. `identities` is null for read-only (query) sources. */
export type RecordPage = {
  columns: string[];
  rows: RecordValues[];
  identities: DataValue[][] | null;
  total: number;
};
export type PageRequest = { offset: number; limit: number; sorts: Sort[]; filters: Filter[] };

const schemas = new Map<string, Promise<TableSchema>>();
const pages = new Map<string, RecordPage>();
const snapshots = new Map<string, { record: RecordValues; identity: DataValue[] }>();

/** Drops cached schemas and pages; runs after every record write and schema change. */
export function invalidateRuntimeCache(schemaToo = false) {
  pages.clear();
  if (schemaToo) schemas.clear();
}
registerRecordHook({ after: () => invalidateRuntimeCache() });
if (typeof window !== "undefined")
  window.addEventListener("ixtable:database-changed", () => invalidateRuntimeCache(true));

export function tableSchema(table: string): Promise<TableSchema> {
  let hit = schemas.get(table);
  if (!hit) {
    hit = inspectTable(table);
    hit.catch(() => schemas.delete(table));
    schemas.set(table, hit);
  }
  return hit;
}

const pageKey = (source: unknown, request: PageRequest, params: Record<string, unknown>) =>
  JSON.stringify([source, request, params]);

/** A cached page for instant re-navigation (null when not loaded yet). */
export const cachedPage = (
  form: DesignForm,
  request: PageRequest,
  params: Record<string, unknown> = {},
) => pages.get(pageKey(form.source, request, params)) ?? null;

/** Query sources page in DuckDB (Rust wraps the saved SQL), so totals are exact. */
async function queryPage(queryId: string, request: PageRequest, params: Record<string, unknown>) {
  const result = await runSavedQueryPage(queryId, params, request);
  const columns = result.columns.map((name) => ({ name }));
  return {
    columns: result.columns,
    rows: result.rows.map((row) => rowObject(columns, row)),
    identities: null,
    total: result.total,
  };
}

/**
 * Reads one page of a form's source through DuckDB (table page or saved query).
 * `params` are the query source's bound parameter values (see `sourceParams`).
 */
export async function loadPage(
  form: DesignForm,
  request: PageRequest,
  params: Record<string, unknown> = {},
): Promise<RecordPage> {
  const source = form.source;
  let page: RecordPage;
  if (source?.kind === "query" && source.queryId) {
    page = await queryPage(source.queryId, request, params);
  } else if (source?.kind === "table" && source.table) {
    const result = await readTablePage(source.table, request);
    page = {
      columns: result.columns.map((c) => c.name),
      rows: result.rows.map((row) => rowObject(result.columns, row)),
      identities: result.identities,
      total: result.total,
    };
  } else {
    page = { columns: [], rows: [], identities: null, total: 0 };
  }
  pages.set(pageKey(source, request, params), page);
  return page;
}

/** Expression scope for a query source's parameter bindings. */
export type SourceScope = { app: Record<string, unknown>; params: Record<string, unknown> };

/**
 * Evaluates a query source's parameter bindings (`source.params`: name to
 * expression over `app` and `params`). Throws with the parameter name when one fails.
 */
export function sourceParams(form: DesignForm, scope: SourceScope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (form.source?.kind !== "query") return out;
  for (const [name, src] of Object.entries(form.source.params ?? {})) {
    if (!src?.trim()) continue;
    try {
      out[name] = evaluate(src, scope);
    } catch (error) {
      throw new Error(
        `Parameter $${name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return out;
}

/**
 * The record id of the first row of a form's source (the row itself for query
 * sources), or null when the source is empty. Used to open detail/edit views
 * that have no record of their own (design preview, dashboard-embedded forms).
 */
export async function firstRecordId(
  form: DesignForm,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const page = await loadPage(form, { offset: 0, limit: 1, sorts: [], filters: [] }, params);
  const record = page.rows[0];
  if (!record) return null;
  if (form.source?.kind !== "table" || !form.source.table || !page.identities) return record;
  return recordIdFor(await tableSchema(form.source.table), record, page.identities[0]);
}

/** Primary key columns in key order. */
export const keyColumns = (schema: TableSchema) =>
  schema.columns
    .filter((c) => c.primaryKeyPosition > 0)
    .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
    .map((c) => c.name);

/** The id passed to FormRenderer for a row: the key value, a key object, or a rowid snapshot key. */
export function recordIdFor(
  schema: TableSchema,
  record: RecordValues,
  identity: DataValue[],
): unknown {
  const keys = keyColumns(schema);
  if (keys.length === 1) return record[keys[0]];
  if (keys.length > 1) return Object.fromEntries(keys.map((k) => [k, record[k]]));
  const id = `rowid:${schema.name}:${String(fromDataValue(identity[0]))}`;
  snapshots.set(id, { record, identity });
  return id;
}

export type LoadedRecord = { record: RecordValues; identity: DataValue[] };

/** Loads one record by id through DuckDB. */
export async function loadRecord(table: string, recordId: unknown): Promise<LoadedRecord | null> {
  if (typeof recordId === "string" && snapshots.has(recordId))
    return snapshots.get(recordId) ?? null;
  const schema = await tableSchema(table);
  const keys = keyColumns(schema);
  const keyValues: RecordValues =
    recordId && typeof recordId === "object" ? (recordId as RecordValues) : { [keys[0]]: recordId };
  const columns = Object.keys(keyValues).filter((c) => schema.columns.some((x) => x.name === c));
  if (!columns.length) return null;
  const filters: Filter[] = columns.map((column) => {
    const declared = schema.columns.find((c) => c.name === column)?.declaredType ?? "";
    const raw = keyValues[column];
    const numeric =
      /INT|REAL|NUM|DEC|FLOA|DOUB/i.test(declared) && raw !== "" && Number.isFinite(Number(raw));
    const value: DataValue =
      raw == null
        ? { type: "null" }
        : numeric
          ? { type: Number.isInteger(Number(raw)) ? "integer" : "real", value: Number(raw) }
          : { type: "text", value: String(raw) };
    return { column, operator: "eq", value };
  });
  const page = await readTablePage(table, { limit: 1, filters });
  if (!page.rows.length) return null;
  return { record: rowObject(page.columns, page.rows[0]), identity: page.identities[0] };
}

export type Choice = { value: unknown; label: string };

/** Lookup choices for a relationship selector, searched on the display column (DuckDB). */
export async function relationshipChoices(
  relationship: Relationship,
  search = "",
  limit = 50,
): Promise<Choice[]> {
  const { table, valueColumn, displayColumn } = relationship;
  const filters: Filter[] = search.trim()
    ? [
        {
          column: displayColumn,
          operator: "contains",
          value: { type: "text", value: search.trim() },
        },
      ]
    : [];
  const page = await readTablePage(table, {
    limit,
    filters,
    sorts: [{ column: displayColumn, descending: false }],
  });
  return page.rows.map((row) => {
    const record = rowObject(page.columns, row);
    return {
      value: record[valueColumn],
      label: String(record[displayColumn] ?? record[valueColumn] ?? ""),
    };
  });
}

/** Display label for one stored relationship value. */
export async function relationshipLabel(
  relationship: Relationship,
  value: unknown,
): Promise<string> {
  if (value == null || value === "") return "";
  const hit = await loadRecord(relationship.table, { [relationship.valueColumn]: value }).catch(
    () => null,
  );
  const label = hit ? String(hit.record[relationship.displayColumn] ?? value) : String(value);
  shownLabels.set(labelKey(relationship, value), label);
  return label;
}

/** Last label shown per relationship key, so a reloaded field shows it while it revalidates. */
const shownLabels = new Map<string, string>();
const labelKey = (relationship: Relationship, value: unknown) =>
  JSON.stringify([
    relationship.table,
    relationship.valueColumn,
    relationship.displayColumn,
    String(value),
  ]);

/** The label `relationshipLabel` last returned for this key, if any (stale-while-revalidate). */
export function cachedRelationshipLabel(
  relationship: Relationship,
  value: unknown,
): string | undefined {
  if (value == null || value === "") return "";
  return shownLabels.get(labelKey(relationship, value));
}

/** Choices from a saved query: first column is the value, second (optional) the label. */
export async function queryChoices(config: DocumentConfig, queryId: string): Promise<Choice[]> {
  const result = await runQuery(config, queryId, {});
  return result.rows.map((row) => {
    const value = fromDataValue(row[0]);
    return { value, label: String(fromDataValue(row[1] ?? row[0]) ?? "") };
  });
}
