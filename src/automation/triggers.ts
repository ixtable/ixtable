/**
 * Record triggers (PRD §17.3), hooked into src/lib/records.ts.
 *
 * Sync triggers run their action after the initiating write commits, inside the
 * same workflow: the caller's insertRecord/updateRecord awaits them and a failing
 * trigger makes that call reject. The write itself is already committed then;
 * rollback-mode actions only undo their own writes.
 * Async triggers enqueue a job on the durable queue (jobs.rs); the worker runs it.
 * Writes carry their trigger depth; a chain deeper than MAX_TRIGGER_DEPTH fails.
 */
import { evaluate, evaluateBoolean } from "../expr";
import { inspectTable, readTablePage } from "../lib/api";
import { type RecordWrite, registerRecordHook } from "../lib/records";
import type { DataValue, DocumentConfig, Filter } from "../lib/types";
import { enqueueJob, notifyJobsChanged } from "./api";
import { type ActionContext, runAction } from "./runner";
import type { Trigger, TriggerEvent } from "./types";
import { fromDataValue, namedToObject, rowToObject, stableHash, toDataValue } from "./values";

export const MAX_TRIGGER_DEPTH = 5;

/** What an async job carries to the worker. */
export interface JobPayload {
  table: string;
  event: TriggerEvent;
  record: Record<string, unknown>;
  old: Record<string, unknown> | null;
  identity: unknown[];
  triggerDepth: number;
}

export interface TriggerEnv {
  getConfig(): DocumentConfig;
  /** Builds the interactive context sync trigger actions run with. */
  context(base: Partial<ActionContext>): ActionContext;
  app?(): Record<string, unknown>;
}

const enabledFor = (config: DocumentConfig, table: string, event: TriggerEvent) =>
  (config.triggers ?? []).filter((t) => t.enabled && t.table === table && t.event === event);

/**
 * Registers the trigger hook on record writes; returns its unregister function.
 * Before an update that has `updated` triggers, it reads the row so `old` is
 * available even when the caller did not pass `meta.old`.
 */
export function installTriggers(env: TriggerEnv): () => void {
  const previous = new WeakMap<RecordWrite, Record<string, unknown> | null>();
  return registerRecordHook({
    before: async (write) => {
      if (write.operation !== "update" || write.meta?.old || !write.identity) return;
      if (!enabledFor(env.getConfig(), write.table, "updated").length) return;
      previous.set(write, await readRow(write.table, write.identity));
    },
    after: (write, result) =>
      dispatchTriggers(write, result, env, previous.get(write) ?? undefined),
  });
}

/**
 * Default idempotency key: `${triggerId}:${table}:${pk}:${event}:${hash(values)}:${writeId}`.
 * The write id (one per records.ts write call) makes it dedupe retries of the
 * same write only; a later identical write is a new event and enqueues again.
 */
export function defaultIdempotencyKey(
  trigger: Trigger,
  identity: unknown[],
  values: Record<string, unknown>,
  writeId?: string,
): string {
  const key = `${trigger.id}:${trigger.table}:${identity.map(String).join(",")}:${trigger.event}:${stableHash(values)}`;
  return writeId ? `${key}:${writeId}` : key;
}

export async function dispatchTriggers(
  write: RecordWrite,
  result: unknown,
  env: TriggerEnv,
  oldRow?: Record<string, unknown>,
): Promise<void> {
  if (write.operation === "delete") return;
  const event: TriggerEvent = write.operation === "insert" ? "created" : "updated";
  const triggers = enabledFor(env.getConfig(), write.table, event);
  if (!triggers.length) return;
  const depth = (write.meta?.triggerDepth ?? 0) + 1;
  if (depth > MAX_TRIGGER_DEPTH)
    throw new Error(
      `Trigger recursion limit (${MAX_TRIGGER_DEPTH}) exceeded on ${write.table}; check triggers that write to their own table`,
    );
  const identity =
    (write.operation === "insert" ? (result as DataValue[] | null) : write.identity) ?? [];
  const values = namedToObject(write.values);
  const record = (await readRow(write.table, identity)) ?? {
    ...values,
    ...(identity.length === 1 && { rowid: fromDataValue(identity[0]) }),
  };
  const old = write.meta?.old ?? oldRow ?? null;
  const app = env.app?.() ?? {};
  for (const trigger of triggers) {
    const scope = { record, old, app };
    if (trigger.condition?.trim() && !evaluateBoolean(trigger.condition, scope)) continue;
    if (trigger.mode === "async") {
      const plainIdentity = identity.map(fromDataValue);
      const key = trigger.idempotencyKey?.trim()
        ? String(evaluate(trigger.idempotencyKey, { ...scope, trigger: { id: trigger.id } }))
        : defaultIdempotencyKey(trigger, plainIdentity, values, write.meta?.writeId);
      const payload: JobPayload = {
        table: write.table,
        event,
        record,
        old,
        identity: plainIdentity,
        triggerDepth: depth,
      };
      await enqueueJob({
        triggerId: trigger.id,
        actionId: trigger.actionId,
        payload,
        idempotencyKey: key,
        maxAttempts: trigger.maxAttempts,
        backoffMs: trigger.backoffMs,
      });
      notifyJobsChanged();
      continue;
    }
    const outcome = await runAction(
      trigger.actionId,
      env.context({ record, old: old ?? undefined, triggerDepth: depth }),
    );
    if (!outcome.ok)
      throw new Error(`Trigger "${trigger.name}" failed: ${outcome.error ?? "unknown error"}`);
  }
}

/** Reads one row by identity (primary key values, or rowid); null when it can't. */
export async function readRow(
  table: string,
  identity: DataValue[],
): Promise<Record<string, unknown> | null> {
  try {
    const keys = (await inspectTable(table)).columns
      .filter((c) => c.primaryKeyPosition > 0)
      .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
      .map((c) => c.name);
    if (!keys.length || keys.length !== identity.length) return null;
    const filters: Filter[] = keys.map((column, i) => ({
      column,
      operator: "eq",
      value: identity[i] ?? toDataValue(null),
    }));
    const page = await readTablePage(table, { filters, limit: 1 });
    return page.rows[0] ? rowToObject(page.columns, page.rows[0]) : null;
  } catch {
    return null;
  }
}
