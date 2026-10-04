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
  /**
   * Write straight to the store even when the entity's policy is `customAction`.
   * Set by the steps of a running custom action, so they do not re-route to it.
   */
  direct?: boolean;
}

/**
 * Thrown when the write committed but an after hook (a sync trigger) failed.
 * The record changes are saved; `results` holds the write results.
 */
export class CommittedWriteError extends Error {
  readonly committed = true;
  constructor(
    message: string,
    readonly results: unknown[],
  ) {
    super(message);
  }
}

/**
 * Takes over an update or delete instead of writing it (custom-action entities).
 * Returns undefined to let the write go to the store.
 */
export type RecordRouter = (write: RecordWrite) => Promise<number> | undefined;
let router: RecordRouter | null = null;

/** Installs the update/delete router (one at a time); returns its uninstall function. */
export function setRecordRouter(next: RecordRouter): () => void {
  router = next;
  return () => {
    if (router === next) router = null;
  };
}

export interface RecordHook {
  // Runs before the write; throwing aborts it.
  before?: (write: RecordWrite) => void | Promise<void>;
  // Runs after the write commits, with the command result.
  after?: (write: RecordWrite, result: unknown) => void | Promise<void>;
}

const hooks = new Set<RecordHook>();

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

/** Runs after hooks for committed writes; a failure becomes a CommittedWriteError. */
async function afterCommit(writes: RecordWrite[], results: unknown[], active: RecordHook[]) {
  const failures: string[] = [];
  for (const [i, record] of writes.entries())
    for (const hook of active) {
      try {
        await hook.after?.(record, results[i]);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
  if (failures.length) throw new CommittedWriteError(failures.join("; "), results);
}

async function write<T>(input: RecordWrite, run: () => Promise<T>): Promise<T> {
  const record = withWriteId(input);
  if (record.operation !== "insert" && !record.meta?.direct) {
    const routed = router?.(record);
    if (routed) return (await routed) as T;
  }
  const active = [...hooks];
  for (const hook of active) await hook.before?.(record);
  const result = await run();
  await afterCommit([record], [result], active);
  return result;
}

/** Inserts a row and resolves with the new row's identity values. */
export const insertRecord = (table: string, values: NamedValue[], meta?: RecordWriteMeta) =>
  write({ operation: "insert", table, values, identity: null, ...(meta && { meta }) }, () =>
    call<DataValue[]>("insert_row", { table, values }),
  );

/**
 * Updates one row by identity and resolves with the affected row count. On a
 * `customAction` entity the entity's action runs instead (see src/automation/custom.ts).
 */
export const updateRecord = (
  table: string,
  values: NamedValue[],
  identity: DataValue[],
  meta?: RecordWriteMeta,
) =>
  write({ operation: "update", table, values, identity, ...(meta && { meta }) }, () =>
    call<number>("update_row", { table, values, identity, expected: meta?.expected ?? null }),
  );

/** Deletes one row by identity and resolves with the affected row count (custom actions as above). */
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
 * for inserts, affected count otherwise). A failing after hook rejects with a
 * CommittedWriteError: the batch is saved. Writes are never routed to custom
 * actions here; the action runner routes them before batching.
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
  const results = writes.map((record, i) =>
    record.operation === "insert" ? (outcomes[i]?.identity ?? []) : (outcomes[i]?.changed ?? 0),
  );
  await afterCommit(writes, results, active);
  return results;
}
