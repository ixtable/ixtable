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
  /** Marks the write as a step of an app-mode trigger (see src-tauri/src/trigger_auth.rs). */
  trigger?: TriggerStepAuth;
}

/** What an app-mode trigger presents to Rust: its sync grant, or its job lease. */
export interface TriggerAuth {
  triggerId: string;
  grant?: string;
  jobId?: string;
  leaseToken?: string;
}
export type TriggerStepAuth = TriggerAuth & { stepId: string };

/** Extra outcome of a committed write: the grant for its app-mode sync triggers. */
export interface WriteExtra {
  triggerGrant?: string;
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
  after?: (write: RecordWrite, result: unknown, extra?: WriteExtra) => void | Promise<void>;
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

interface Outcome {
  changed: number;
  identity?: DataValue[] | null;
  triggerGrant?: string;
}

const toOp = ({ operation, table, values, identity, meta }: RecordWrite) =>
  operation === "insert"
    ? { op: "insert", table, values }
    : operation === "update"
      ? { op: "update", table, values, identity, expected: meta?.expected ?? null }
      : { op: "delete", table, identity, expected: meta?.expected ?? null };

const resultOf = (record: RecordWrite, outcome: Outcome | undefined) =>
  record.operation === "insert" ? (outcome?.identity ?? []) : (outcome?.changed ?? 0);

/**
 * Runs after hooks for committed writes, each with its result and trigger grant;
 * a failure becomes a CommittedWriteError (the writes stay saved).
 */
async function afterCommit(
  writes: RecordWrite[],
  outcomes: (Outcome | undefined)[],
  active: RecordHook[],
): Promise<unknown[]> {
  const results = writes.map((record, i) => resultOf(record, outcomes[i]));
  const failures: string[] = [];
  for (const [i, record] of writes.entries()) {
    const grant = outcomes[i]?.triggerGrant;
    for (const hook of active) {
      try {
        await hook.after?.(record, results[i], grant ? { triggerGrant: grant } : undefined);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  if (failures.length) throw new CommittedWriteError(failures.join("; "), results);
  return results;
}

async function write<T>(
  input: RecordWrite,
  send: (record: RecordWrite) => Promise<Outcome>,
): Promise<T> {
  const record = withWriteId(input);
  if (record.operation !== "insert" && !record.meta?.direct) {
    const routed = router?.(record);
    if (routed) return (await routed) as T;
  }
  const active = [...hooks];
  for (const hook of active) await hook.before?.(record);
  const outcome = await send(record);
  const [result] = await afterCommit([record], [outcome], active);
  return result as T;
}

const trigger = (record: RecordWrite) => record.meta?.trigger ?? null;

/** Inserts a row and resolves with the new row's identity values. */
export const insertRecord = (table: string, values: NamedValue[], meta?: RecordWriteMeta) =>
  write<DataValue[]>(
    { operation: "insert", table, values, identity: null, ...(meta && { meta }) },
    (record) => call<Outcome>("insert_row", { table, values, trigger: trigger(record) }),
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
  write<number>({ operation: "update", table, values, identity, ...(meta && { meta }) }, (record) =>
    call<Outcome>("update_row", {
      table,
      values,
      identity,
      expected: meta?.expected ?? null,
      trigger: trigger(record),
    }),
  );

/** Deletes one row by identity and resolves with the affected row count (custom actions as above). */
export const deleteRecord = (table: string, identity: DataValue[], meta?: RecordWriteMeta) =>
  write<number>(
    { operation: "delete", table, values: [], identity, ...(meta && { meta }) },
    (record) =>
      call<Outcome>("delete_row", {
        table,
        identity,
        expected: meta?.expected ?? null,
        trigger: trigger(record),
      }),
  );

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
  const outcomes = await call<Outcome[]>("execute_write_batch", {
    ops: writes.map(toOp),
    triggers: writes.map((w) => w.meta?.trigger ?? null),
  });
  return afterCommit(writes, outcomes, active);
}
