import { runQuery } from "../automation/runner";
import type { DesignForm, Relationship } from "../design/schema";
import { inspectTable, listDatabaseObjects, readTablePage } from "../lib/api";
import { registerRecordHook } from "../lib/records";
import type { DataValue, DocumentConfig, Filter, Sort, TableSchema } from "../lib/types";
import {
  pagedScan,
  type RowPredicate,
  rowFilter,
  type ScanResult,
  scanFiltered,
} from "./conditions";
import { fromDataValue, type RecordValues, rowObject } from "./values";

/**
 * One page of records for a list. `identities` is null for read-only (query) sources.
 * `truncated` is true when a row filter stopped at `SCAN_LIMIT` rows: matches past that
 * point are missing and `total` counts only the rows scanned.
 */
export type RecordPage = {
  columns: string[];
  rows: RecordValues[];
  identities: DataValue[][] | null;
  total: number;
  truncated?: boolean;
};
export type PageRequest = { offset: number; limit: number; sorts: Sort[]; filters: Filter[] };

const schemas = new Map<string, Promise<TableSchema>>();
const pages = new Map<string, RecordPage>();
type Matched = { record: RecordValues; identity: DataValue[] };
// One filtered scan per (source, sorts, search, filter, inputs); pages slice it locally.
const scans = new Map<string, Promise<ScanResult<Matched> & { columns: string[] }>>();
const snapshots = new Map<string, { record: RecordValues; identity: DataValue[] }>();

/** Drops cached schemas and pages; runs after every record write and schema change. */
export function invalidateRuntimeCache(schemaToo = false) {
  pages.clear();
  scans.clear();
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

/**
 * A table with what generated forms need around it: the tables its foreign keys point at
 * (lookup display columns) and the tables pointing at it (one-level related lists).
 */
export async function tableContext(table: string) {
  const schema = await tableSchema(table);
  const objects = await listDatabaseObjects();
  const known = (
    await Promise.all(
      objects
        .filter((object) => object.objectType === "table")
        .map((object) => tableSchema(object.name).catch(() => null)),
    )
  ).filter((other): other is TableSchema => !!other);
  return {
    schema,
    targets: Object.fromEntries(known.map((other) => [other.name, other])),
    children: known.filter((other) => other.foreignKeys.some((fk) => fk.targetTable === table)),
  };
}

const pageKey = (form: DesignForm, request: PageRequest, scope: Record<string, unknown>) =>
  JSON.stringify([form.source, form.filter?.trim() ? [form.filter, scope] : null, request]);

/** A cached page for instant re-navigation (null when not loaded yet). */
export const cachedPage = (
  form: DesignForm,
  request: PageRequest,
  scope: Record<string, unknown> = {},
) => pages.get(pageKey(form, request, scope)) ?? null;

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

async function queryPage(
  config: DocumentConfig,
  queryId: string,
  request: PageRequest,
  keep: RowPredicate | null,
) {
  const result = await runQuery(config, queryId, {});
  let rows = result.rows.map((row) =>
    rowObject(
      result.columns.map((name) => ({ name })),
      row,
    ),
  );
  rows = rows.filter(
    (row) => request.filters.every((f) => matches(row[f.column], f)) && (!keep || keep(row)),
  );
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

/**
 * A table page with a row filter. The table is scanned once (up to `SCAN_LIMIT` rows) per
 * sort, search, filter and filter inputs; every page is then a slice of the cached matches,
 * so paging never rescans and `total` is the real match count.
 */
async function filteredTablePage(
  table: string,
  request: PageRequest,
  keep: RowPredicate,
  key: string,
): Promise<RecordPage> {
  let scan = scans.get(key);
  if (!scan) {
    let columns: string[] = [];
    scan = pagedScan(
      async (offset, limit) => {
        const result = await readTablePage(table, { ...request, offset, limit });
        columns = result.columns.map((c) => c.name);
        return result.rows.map((row, i) => ({
          record: rowObject(result.columns, row),
          identity: result.identities[i],
        }));
      },
      (row) => keep(row.record),
    ).then((found) => ({ ...found, columns }));
    scan.catch(() => scans.delete(key));
    scans.set(key, scan);
  }
  const found = await scan;
  const shown = found.matches.slice(request.offset, request.offset + request.limit);
  return {
    columns: found.columns,
    rows: shown.map((row) => row.record),
    identities: shown.map((row) => row.identity),
    total: found.matches.length,
    truncated: found.truncated,
  };
}

/**
 * Reads one page of a form's source through DuckDB (table page or saved query). A form
 * `filter` expression is applied to the fetched rows with `scope` (`app`, `params`).
 */
export async function loadPage(
  config: DocumentConfig,
  form: DesignForm,
  request: PageRequest,
  scope: Record<string, unknown> = {},
): Promise<RecordPage> {
  const source = form.source;
  const keep = rowFilter(form.filter, { form: {}, params: {}, parent: null, ...scope });
  let page: RecordPage;
  if (source?.kind === "query" && source.queryId) {
    page = await queryPage(config, source.queryId, request, keep);
  } else if (source?.kind === "table" && source.table && keep) {
    const scanKey = pageKey(form, { ...request, offset: 0, limit: 0 }, scope);
    page = await filteredTablePage(source.table, request, keep, scanKey);
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
  pages.set(pageKey(form, request, scope), page);
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

/** A choice; relationship choices also carry the target record (multi-column keys). */
export type Choice = { value: unknown; label: string; record?: RecordValues };

/**
 * A relationship key: the stored value of a single-column key, or target column → value
 * for a multi-column key. Empty when any part is missing.
 */
export type RelationshipKey = unknown;
const emptyKey = (value: RelationshipKey) =>
  value == null ||
  value === "" ||
  (typeof value === "object" &&
    Object.values(value as RecordValues).some((part) => part == null || part === ""));
const keyText = (value: RelationshipKey) =>
  typeof value === "object" ? JSON.stringify(value) : String(value);

/**
 * Lookup choices for a relationship selector, searched on the display column (DuckDB).
 * A relationship `filter` keeps only choice rows it accepts (`record` is the choice row;
 * `scope` supplies `parent`, `form` and `app`); rows are scanned until `limit` match.
 */
export async function relationshipChoices(
  relationship: Relationship,
  search = "",
  limit = 50,
  scope: Record<string, unknown> = {},
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
  const sorts: Sort[] = [{ column: displayColumn, descending: false }];
  const keep = rowFilter(relationship.filter, { form: {}, app: {}, params: {}, ...scope });
  const toChoice = (record: RecordValues): Choice => ({
    value: record[valueColumn],
    label: String(record[displayColumn] ?? record[valueColumn] ?? ""),
    record,
  });
  if (!keep) {
    const page = await readTablePage(table, { limit, filters, sorts });
    return page.rows.map((row) => toChoice(rowObject(page.columns, row)));
  }
  const scan = await scanFiltered(
    async (offset, size) => {
      const page = await readTablePage(table, { offset, limit: size, filters, sorts });
      return page.rows.map((row) => rowObject(page.columns, row));
    },
    keep,
    limit,
  );
  return scan.matches.slice(0, limit).map(toChoice);
}

/** Display label for one stored relationship key. */
export async function relationshipLabel(
  relationship: Relationship,
  value: RelationshipKey,
): Promise<string> {
  if (emptyKey(value)) return "";
  const keys =
    typeof value === "object" ? (value as RecordValues) : { [relationship.valueColumn]: value };
  const hit = await loadRecord(relationship.table, keys).catch(() => null);
  const shown = hit?.record[relationship.displayColumn];
  const label = shown != null ? String(shown) : typeof value === "object" ? "" : String(value);
  shownLabels.set(labelKey(relationship, value), label);
  return label;
}

/** Last label shown per relationship key, so a reloaded field shows it while it revalidates. */
const shownLabels = new Map<string, string>();
const labelKey = (relationship: Relationship, value: RelationshipKey) =>
  JSON.stringify([
    relationship.table,
    relationship.valueColumn,
    relationship.displayColumn,
    keyText(value),
  ]);

/** The label `relationshipLabel` last returned for this key, if any (stale-while-revalidate). */
export function cachedRelationshipLabel(
  relationship: Relationship,
  value: RelationshipKey,
): string | undefined {
  if (emptyKey(value)) return "";
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
