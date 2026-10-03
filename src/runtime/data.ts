import { runQuery } from "../automation/runner";
import type { DesignForm, Relationship } from "../design/schema";
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

const pageKey = (source: unknown, request: PageRequest) => JSON.stringify([source, request]);

/** A cached page for instant re-navigation (null when not loaded yet). */
export const cachedPage = (form: DesignForm, request: PageRequest) =>
  pages.get(pageKey(form.source, request)) ?? null;

const matches = (value: unknown, filter: Filter): boolean => {
  const target = filter.value ? fromDataValue(filter.value) : null;
  const text = String(value ?? "").toLowerCase();
  switch (filter.operator) {
    case "contains":
      return text.includes(String(target ?? "").toLowerCase());
    case "starts_with":
      return text.startsWith(String(target ?? "").toLowerCase());
    case "is_null":
      return value == null;
    case "is_not_null":
      return value != null;
    case "eq":
      return String(value) === String(target);
    case "ne":
      return String(value) !== String(target);
    default: {
      const a = Number(value);
      const b = Number(target);
      if (filter.operator === "lt") return a < b;
      if (filter.operator === "lte") return a <= b;
      if (filter.operator === "gt") return a > b;
      return a >= b;
    }
  }
};

async function queryPage(config: DocumentConfig, queryId: string, request: PageRequest) {
  const result = await runQuery(config, queryId, {});
  let rows = result.rows.map((row) =>
    rowObject(
      result.columns.map((name) => ({ name })),
      row,
    ),
  );
  rows = rows.filter((row) => request.filters.every((f) => matches(row[f.column], f)));
  for (const sort of [...request.sorts].reverse()) {
    rows = [...rows].sort((a, b) => {
      const x = a[sort.column];
      const y = b[sort.column];
      const order = x == null ? -1 : y == null ? 1 : x < y ? -1 : x > y ? 1 : 0;
      return sort.descending ? -order : order;
    });
  }
  return {
    columns: result.columns,
    rows: rows.slice(request.offset, request.offset + request.limit),
    identities: null,
    total: rows.length,
  };
}

/** Reads one page of a form's source through DuckDB (table page or saved query). */
export async function loadPage(
  config: DocumentConfig,
  form: DesignForm,
  request: PageRequest,
): Promise<RecordPage> {
  const source = form.source;
  let page: RecordPage;
  if (source?.kind === "query" && source.queryId) {
    page = await queryPage(config, source.queryId, request);
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
  pages.set(pageKey(source, request), page);
  return page;
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
  return hit ? String(hit.record[relationship.displayColumn] ?? value) : String(value);
}

/** Choices from a saved query: first column is the value, second (optional) the label. */
export async function queryChoices(config: DocumentConfig, queryId: string): Promise<Choice[]> {
  const result = await runQuery(config, queryId, {});
  return result.rows.map((row) => {
    const value = fromDataValue(row[0]);
    return { value, label: String(fromDataValue(row[1] ?? row[0]) ?? "") };
  });
}
