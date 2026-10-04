import { call } from "./api";
import type { DataValue, NamedValue } from "./types";
import { newId } from "./utils";

export type RecordOperation = "insert" | "update" | "delete";

export interface RecordWrite {
  operation: RecordOperation;
  table: string;
  values: NamedValue[];
  identity: DataValue[] | null;
  /** Workflow context supplied by the caller (automation uses it for trigger semantics). */
  meta?: RecordWriteMeta;
}

export interface RecordWriteMeta {
  /** Trigger nesting depth of the workflow issuing this write (recursion guard). */
  triggerDepth?: number;
  /** Previous values of the updated row, when the caller knows them (`old` in trigger scopes). */
  old?: Record<string, unknown>;
  /** Original values the edit started from; optimistic entities reject the write with CONFLICT if they changed. */
  expected?: NamedValue[];
  /**
   * Identity of this write call (a uuid set by records.ts when absent). A caller
   * retrying the same write passes the same id, so async triggers dedupe it.
   */
  writeId?: string;
}

export interface RecordHook {
  // Runs before the write; throwing aborts it.
  before?: (write: RecordWrite) => void | Promise<void>;
  // Runs after the write commits, with the command result.
  after?: (write: RecordWrite, result: unknown) => void | Promise<void>;
}

const hooks = new Set<RecordHook>();

/** Fired once per tick after record writes commit (narrower than `ixtable:database-changed`). */
export const RECORDS_CHANGED_EVENT = "ixtable:records-changed";
let announcing = false;

function announceChange() {
  if (announcing || typeof window === "undefined") return;
  announcing = true;
  setTimeout(() => {
    announcing = false;
    window.dispatchEvent(new Event(RECORDS_CHANGED_EVENT));
  }, 0);
}

/** Registers a hook on every record write and returns its unregister function. */
export function registerRecordHook(hook: RecordHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

/** Gives the write a `meta.writeId` (kept when the caller supplied one). */
function withWriteId(record: RecordWrite): RecordWrite {
  return record.meta?.writeId ? record : { ...record, meta: { ...record.meta, writeId: newId() } };
}

async function write<T>(input: RecordWrite, run: () => Promise<T>): Promise<T> {
  const record = withWriteId(input);
  const active = [...hooks];
  for (const hook of active) await hook.before?.(record);
  const result = await run();
  announceChange();
  for (const hook of active) await hook.after?.(record, result);
  return result;
}

/** Inserts a row and resolves with the new row's identity values. */
export const insertRecord = (table: string, values: NamedValue[], meta?: RecordWriteMeta) =>
  write({ operation: "insert", table, values, identity: null, ...(meta && { meta }) }, () =>
    call<DataValue[]>("insert_row", { table, values }),
  );

/** Updates one row by identity and resolves with the affected row count. */
export const updateRecord = (
  table: string,
  values: NamedValue[],
  identity: DataValue[],
  meta?: RecordWriteMeta,
) =>
  write({ operation: "update", table, values, identity, ...(meta && { meta }) }, () =>
    call<number>("update_row", { table, values, identity, expected: meta?.expected ?? null }),
  );

/** Deletes one row by identity and resolves with the affected row count. */
export const deleteRecord = (table: string, identity: DataValue[], meta?: RecordWriteMeta) =>
  write({ operation: "delete", table, values: [], identity, ...(meta && { meta }) }, () =>
    call<number>("delete_row", { table, identity, expected: meta?.expected ?? null }),
  );

interface BatchOutcome {
  changed: number;
  identity?: DataValue[] | null;
}

/**
 * Applies several writes as one RecordStore transaction (`execute_write_batch`):
 * all succeed or none do. Before hooks run for every write first (any throw aborts
 * the batch); after hooks run once it commits, each with its own result (identity
 * for inserts, affected count otherwise).
 */
export async function writeRecordBatch(input: RecordWrite[]): Promise<unknown[]> {
  const writes = input.map(withWriteId);
  const active = [...hooks];
  for (const record of writes) for (const hook of active) await hook.before?.(record);
  const ops = writes.map(({ operation, table, values, identity, meta }) =>
    operation === "insert"
      ? { op: "insert", table, values }
      : operation === "update"
        ? { op: "update", table, values, identity, expected: meta?.expected ?? null }
        : { op: "delete", table, identity, expected: meta?.expected ?? null },
  );
  const outcomes = await call<BatchOutcome[]>("execute_write_batch", { ops });
  announceChange();
  const results = writes.map((record, i) =>
    record.operation === "insert" ? (outcomes[i]?.identity ?? []) : (outcomes[i]?.changed ?? 0),
  );
  for (const [i, record] of writes.entries())
    for (const hook of active) await hook.after?.(record, results[i]);
  return results;
}
