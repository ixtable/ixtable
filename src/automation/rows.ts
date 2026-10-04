/**
 * Row lookups for record steps: which rows an update or delete step matches,
 * with the identity and original values (`expected`) each write sends.
 */
import { inspectTable, readTablePage } from "../lib/api";
import type { TriggerStepAuth } from "../lib/records";
import type { DataValue, DbColumn, Filter, NamedValue } from "../lib/types";
import { logicalOf } from "../schema/logical";
import { fromDataValue, rowToObject, toDataValue } from "./values";

/** Rows read per page while collecting a step's matches. */
export const MATCH_PAGE_SIZE = 1000;
/**
 * Most rows one update or delete step may match. Above it the step fails before
 * writing anything, instead of silently handling only part of the matches.
 */
export const MAX_MATCHED_ROWS = 100_000;

export interface FoundRow {
  identity: DataValue[];
  object: Record<string, unknown>;
  /** Original values for the optimistic check (stored, non-generated, non-blob columns). */
  expected: NamedValue[];
  /** True when `expected` was just read from the database (not a snapshot). */
  fresh: boolean;
}

export const keyColumns = (columns: DbColumn[]) =>
  columns
    .filter((c) => c.primaryKeyPosition > 0)
    .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
    .map((c) => c.name);

/** Columns whose original values can be compared at write time. */
const comparable = (columns: DbColumn[]) =>
  new Set(columns.filter((c) => !c.generated && logicalOf(c) !== "blob").map((c) => c.name));

/**
 * Every row of `table` matching `criteria` (column → value; null matches NULL),
 * read page by page in identity order. Throws when none match or when more than
 * MAX_MATCHED_ROWS do. `trigger` authorizes the reads of an app-mode trigger step.
 */
export async function matchRows(
  table: string,
  criteria: Record<string, unknown>,
  trigger?: TriggerStepAuth,
): Promise<FoundRow[]> {
  const schema = await inspectTable(table, trigger);
  const keep = comparable(schema.columns);
  const filters: Filter[] = Object.entries(criteria).map(([column, value]) =>
    value === null || value === undefined
      ? { column, operator: "is_null" }
      : { column, operator: "eq", value: toDataValue(value) },
  );
  const found: FoundRow[] = [];
  for (let offset = 0; ; offset += MATCH_PAGE_SIZE) {
    const page = await readTablePage(table, { filters, offset, limit: MATCH_PAGE_SIZE }, trigger);
    if (page.total > MAX_MATCHED_ROWS)
      throw new Error(
        `${page.total} ${table} rows match; one step can change at most ${MAX_MATCHED_ROWS}. Narrow the match.`,
      );
    for (const [i, row] of page.rows.entries())
      found.push({
        identity: page.identities[i],
        object: rowToObject(page.columns, row),
        expected: page.columns
          .map((c, j) => ({ column: c.name, value: row[j] }))
          .filter((v) => keep.has(v.column)),
        fresh: true,
      });
    if (page.rows.length < MATCH_PAGE_SIZE) break;
  }
  if (!found.length) throw new Error(`No ${table} rows match`);
  return found;
}

/**
 * The current record as a row to write: by its key columns, else by its rowid.
 * Without a key the row is not re-read, so `expected` comes from `snapshot` (the
 * record as loaded, before unsaved edits) when given, else from `record`.
 */
export async function currentRow(
  table: string,
  record: Record<string, unknown> | null,
  snapshot?: Record<string, unknown> | null,
  trigger?: TriggerStepAuth,
): Promise<FoundRow[]> {
  if (!record) throw new Error("There is no current record");
  const schema = await inspectTable(table, trigger);
  const keys = keyColumns(schema.columns);
  if (keys.length)
    return matchRows(
      table,
      Object.fromEntries(
        keys.map((k) => {
          if (record[k] === undefined || record[k] === null)
            throw new Error(`The current record has no value for key column ${k}`);
          return [k, record[k]];
        }),
      ),
      trigger,
    );
  if (record.rowid === undefined || record.rowid === null)
    throw new Error(`Table ${table} has no primary key and the record has no rowid`);
  const keep = comparable(schema.columns);
  return [
    {
      identity: [toDataValue(record.rowid)],
      object: record,
      expected: Object.entries(snapshot ?? record)
        .filter(([column]) => keep.has(column))
        .map(([column, value]) => ({ column, value: toDataValue(value) })),
      fresh: false,
    },
  ];
}

/** `values` plus the generated key of a created row (rowid when there is no key). */
export async function withKeys(
  table: string,
  values: Record<string, unknown>,
  identity: DataValue[],
  trigger?: TriggerStepAuth,
) {
  try {
    const keys = keyColumns((await inspectTable(table, trigger)).columns);
    const names = keys.length ? keys : ["rowid"];
    return {
      ...values,
      ...Object.fromEntries(names.map((k, i) => [k, fromDataValue(identity[i])])),
    };
  } catch {
    return { ...values };
  }
}

/** Comparable original values of `object` (a row as read or loaded) for `table`. */
export async function expectedOf(
  table: string,
  object: Record<string, unknown>,
): Promise<NamedValue[]> {
  const keep = comparable((await inspectTable(table)).columns);
  return Object.entries(object)
    .filter(([column]) => keep.has(column))
    .map(([column, value]) => ({ column, value: toDataValue(value) }));
}

/** Key of a row within one action run: table plus identity. */
export const rowKey = (table: string, identity: DataValue[]) =>
  `${table}\u0000${JSON.stringify(identity)}`;

/** `expected` after writing `values` over it: the row's values once the write applies. */
export const afterWrite = (expected: NamedValue[], values: NamedValue[]): NamedValue[] => {
  const written = new Map(values.map((v) => [v.column, v.value]));
  return expected.map((v) =>
    written.has(v.column) ? { ...v, value: written.get(v.column) as DataValue } : v,
  );
};
