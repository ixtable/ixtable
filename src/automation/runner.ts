/**
 * Declarative action runner (PRD §17.2). Every expression goes through src/expr,
 * every record write through src/lib/records.ts (so triggers see it), and every
 * read through the DuckDB read path.
 *
 * Failure behavior (`ActionDef.onError`):
 * - stop: the first failing step ends the action; earlier writes stay committed.
 * - continue: failing steps are logged and skipped; the action reports ok.
 * - rollback: a transactional action. Record writes are collected and applied at
 *   the end as one RecordStore transaction (`writeRecordBatch`); a failing step or a
 *   failing commit saves none of them. Steps read the data as it was before the
 *   action (pending writes are not visible to later lookups, and `storeAs` on a
 *   created record holds its values, not its generated key). Navigation, messages
 *   and state changes are held back until the commit succeeds.
 * A declined `confirm` always ends the action (saving nothing in rollback mode).
 * Nested runAction steps join the caller's transaction when there is one.
 */
import { evaluate, evaluateBoolean } from "../expr";
import { call, executeReadQuery, inspectTable, readTablePage } from "../lib/api";
import {
  deleteRecord,
  insertRecord,
  type RecordWrite,
  type RecordWriteMeta,
  updateRecord,
  writeRecordBatch,
} from "../lib/records";
import type { DataValue, DocumentConfig, Filter, QueryResult } from "../lib/types";
import * as queryApi from "../query/api";
import type { ActionDef, MatchSpec, OnError, Step, StepLog, ValueMap } from "./types";
import { fromDataValue, rowToObject, toDataValue, toNamedValues } from "./values";

export { ActionPicker } from "./ActionPicker";

export interface NavigationTarget {
  kind: "form" | "report" | "dashboard" | "table";
  id: string;
  mode?: string;
  recordId?: unknown;
  params?: Record<string, unknown>;
}

export interface ActionContext {
  config: DocumentConfig;
  record?: Record<string, unknown>;
  form?: Record<string, unknown>;
  app: Record<string, unknown>;
  params?: Record<string, unknown>;
  navigate(target: NavigationTarget): void;
  setState(scope: "app" | "form", key: string, value: unknown): void;
  confirm(message: string): Promise<boolean>;
  notify(message: string, tone?: "info" | "error"): void;
  authorize?(kind: string, id: string, op: string): boolean;
  refresh?(): void;
  /** Previous values of `record` (update triggers). */
  old?: Record<string, unknown>;
  /** Trigger nesting depth of this run; writes carry it so triggers can stop recursion. */
  triggerDepth?: number;
  /** Clock for today()/now(); defaults to the current time. */
  now?: Date;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** True when a confirm step was declined. */
  cancelled?: boolean;
  steps: StepLog[];
  /** Values stored by steps with `storeAs`. */
  results: Record<string, unknown>;
}

/** Maximum nesting of runAction steps. */
export const MAX_ACTION_DEPTH = 10;

class Cancelled extends Error {
  constructor() {
    super("Cancelled by user");
  }
}
class StepFailure extends Error {}

/** Writes and UI effects held back until a rollback-mode action commits. */
interface Transaction {
  writes: RecordWrite[];
  effects: (() => void)[];
}
interface Frame {
  ctx: ActionContext;
  scope: Record<string, unknown> & { results: Record<string, unknown> };
  logs: StepLog[];
  onError: OnError;
  tx: Transaction | null;
  stack: string[];
  wrote: { value: boolean };
}

const message = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);

/** Runs an action (or the action with this id) against `ctx`. Never throws. */
export async function runAction(
  action: ActionDef | string,
  ctx: ActionContext,
): Promise<ActionResult> {
  const results: Record<string, unknown> = {};
  const def = typeof action === "string" ? ctx.config.actions.find((a) => a.id === action) : action;
  if (!def)
    return { ok: false, error: `Action ${String(action)} does not exist`, steps: [], results };
  if (ctx.authorize && !ctx.authorize("action", def.id, "execute"))
    return { ok: false, error: "Not permitted", steps: [], results };
  const frame: Frame = {
    ctx,
    scope: {
      record: ctx.record ?? null,
      old: ctx.old ?? null,
      form: { ...ctx.form },
      app: { ...ctx.app },
      params: { ...ctx.params },
      results,
      steps: results,
    },
    logs: [],
    onError: def.onError ?? "stop",
    tx: null,
    stack: [],
    wrote: { value: false },
  };
  const outcome = await execute(def, frame, "");
  if (frame.wrote.value) ctx.refresh?.();
  return { ...outcome, steps: frame.logs, results };
}

async function execute(
  action: ActionDef,
  parent: Frame,
  prefix: string,
): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  const own: Transaction | null =
    (action.onError ?? "stop") === "rollback" && !parent.tx ? { writes: [], effects: [] } : null;
  const frame: Frame = {
    ...parent,
    onError: action.onError ?? "stop",
    tx: parent.tx ?? own,
    stack: [...parent.stack, action.id],
  };
  try {
    await runSteps(action.steps ?? [], frame, prefix);
  } catch (e) {
    const unsaved = own?.writes.length ? "; no record changes were saved" : "";
    return {
      ok: false,
      error: message(e) + unsaved,
      ...(e instanceof Cancelled && { cancelled: true }),
    };
  }
  if (!own) return { ok: true };
  if (own.writes.length) {
    try {
      await writeRecordBatch(own.writes);
      frame.wrote.value = true;
    } catch (e) {
      return {
        ok: false,
        error: `Transaction failed: ${message(e)}; no record changes were saved`,
      };
    }
  }
  try {
    for (const effect of own.effects) effect();
  } catch (e) {
    return { ok: false, error: `${message(e)} (after the record changes were saved)` };
  }
  return { ok: true };
}

async function runSteps(steps: Step[], frame: Frame, prefix: string): Promise<void> {
  for (const [index, step] of steps.entries()) {
    const path = prefix ? `${prefix}.${index}` : String(index);
    const log: StepLog = { stepIndex: index, path, kind: step.kind, ok: true, durationMs: 0 };
    frame.logs.push(log);
    const started = performance.now();
    try {
      if (step.kind !== "condition" && step.when?.trim() && !condition(step.when, frame)) {
        log.skipped = true;
        continue;
      }
      await runStep(step, frame, path);
    } catch (e) {
      log.ok = false;
      log.error = message(e);
      if (e instanceof Cancelled) throw e;
      if (frame.onError !== "continue")
        throw e instanceof StepFailure
          ? e
          : new StepFailure(`Step ${Number(index) + 1} (${step.kind}) failed: ${log.error}`);
    } finally {
      log.durationMs = Math.round(performance.now() - started);
    }
  }
}

const opts = (frame: Frame) => (frame.ctx.now ? { now: frame.ctx.now } : {});

function expr(src: string | undefined, frame: Frame, what: string): unknown {
  if (!src?.trim()) throw new Error(`${what} has no expression`);
  return evaluate(src, frame.scope, opts(frame));
}
function condition(src: string, frame: Frame): boolean {
  return evaluateBoolean(src, frame.scope, opts(frame));
}
function evalMap(map: ValueMap | undefined, frame: Frame): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(map ?? {}).map(([key, src]) => [key, expr(src, frame, `Value for ${key}`)]),
  );
}
function authorize(frame: Frame, kind: string, id: string, op: string) {
  if (frame.ctx.authorize && !frame.ctx.authorize(kind, id, op)) throw new Error("Not permitted");
}
const writeMeta = (frame: Frame, extra: RecordWriteMeta = {}): RecordWriteMeta => ({
  triggerDepth: frame.ctx.triggerDepth ?? 0,
  ...extra,
});
/** Runs a UI effect now, or after the commit inside a transaction. */
function effect(frame: Frame, run: () => void) {
  if (frame.tx) frame.tx.effects.push(run);
  else run();
}

async function runStep(step: Step, frame: Frame, path: string): Promise<void> {
  const { ctx, scope } = frame;
  switch (step.kind) {
    case "createRecord": {
      authorize(frame, "table", step.table, "create");
      const values = evalMap(step.values, frame);
      const named = toNamedValues(values);
      if (frame.tx) {
        frame.tx.writes.push(write("insert", step.table, named, null, writeMeta(frame)));
        if (step.storeAs) scope.results[step.storeAs] = values;
        return;
      }
      const identity = await insertRecord(step.table, named, writeMeta(frame));
      frame.wrote.value = true;
      if (step.storeAs) scope.results[step.storeAs] = await withKeys(step.table, values, identity);
      return;
    }
    case "updateRecord": {
      authorize(frame, "table", step.table, "update");
      const rows = await findRows(step.table, step.match, frame);
      const values = evalMap(step.values, frame);
      const named = toNamedValues(values);
      for (const row of rows) {
        const meta = writeMeta(frame, { old: row.object });
        if (frame.tx) frame.tx.writes.push(write("update", step.table, named, row.identity, meta));
        else {
          await updateRecord(step.table, named, row.identity, meta);
          frame.wrote.value = true;
        }
      }
      if (step.match === "current" && scope.record && typeof scope.record === "object")
        scope.record = { ...(scope.record as Record<string, unknown>), ...values };
      return;
    }
    case "deleteRecord": {
      authorize(frame, "table", step.table, "delete");
      const rows = await findRows(step.table, step.match, frame);
      for (const row of rows) {
        const meta = writeMeta(frame, { old: row.object });
        if (frame.tx) frame.tx.writes.push(write("delete", step.table, [], row.identity, meta));
        else {
          await deleteRecord(step.table, row.identity, meta);
          frame.wrote.value = true;
        }
      }
      return;
    }
    case "runQuery": {
      authorize(frame, "query", step.queryId, "read");
      const params = evalMap(step.params, frame);
      const result = await runQuery(ctx.config, step.queryId, params);
      const rows = result.rows.map((row) => rowToObject(result.columns, row));
      if (step.storeAs?.trim()) scope.results[step.storeAs] = rows;
      return;
    }
    case "navigate": {
      const target = step.target;
      if (!target?.id) throw new Error("Navigation target is not set");
      exists(ctx.config, target.kind, target.id);
      const to: NavigationTarget = {
        kind: target.kind,
        id: target.id,
        ...(target.mode && { mode: target.mode }),
        ...(target.recordId?.trim() && { recordId: expr(target.recordId, frame, "Record id") }),
      };
      effect(frame, () => ctx.navigate(to));
      return;
    }
    case "openForm": {
      exists(ctx.config, "form", step.formId);
      const to: NavigationTarget = {
        kind: "form",
        id: step.formId,
        ...(step.mode && { mode: step.mode }),
        ...(step.recordId?.trim() && { recordId: expr(step.recordId, frame, "Record id") }),
      };
      effect(frame, () => ctx.navigate(to));
      return;
    }
    case "openReport": {
      exists(ctx.config, "report", step.reportId);
      const params = evalMap(step.params, frame);
      effect(frame, () => ctx.navigate({ kind: "report", id: step.reportId, params }));
      return;
    }
    case "openDashboard":
      exists(ctx.config, "dashboard", step.dashboardId);
      effect(frame, () => ctx.navigate({ kind: "dashboard", id: step.dashboardId }));
      return;
    case "setState": {
      if (!step.key?.trim()) throw new Error("State key is not set");
      const value = expr(step.value, frame, `State ${step.key}`);
      effect(frame, () => ctx.setState(step.scope, step.key, value));
      const bucket = step.scope === "form" ? "form" : "app";
      scope[bucket] = { ...(scope[bucket] as Record<string, unknown>), [step.key]: value };
      return;
    }
    case "confirm": {
      const text = expr(step.message, frame, "Confirmation message");
      if (!(await ctx.confirm(String(text ?? "")))) throw new Cancelled();
      return;
    }
    case "message": {
      const text = String(expr(step.text, frame, "Message") ?? "");
      effect(frame, () => ctx.notify(text, step.tone ?? "info"));
      return;
    }
    case "condition": {
      if (!step.when?.trim()) throw new Error("Condition has no expression");
      const branch = condition(step.when, frame) ? "then" : "else";
      await runSteps(step[branch] ?? [], frame, `${path}.${branch}`);
      return;
    }
    case "runAction": {
      const child = ctx.config.actions.find((a) => a.id === step.actionId);
      if (!child) throw new Error(`Action ${step.actionId} does not exist`);
      if (frame.stack.includes(child.id))
        throw new Error(
          `Recursive action call: ${[...frame.stack, child.id]
            .map((id) => ctx.config.actions.find((a) => a.id === id)?.name ?? id)
            .join(" → ")}`,
        );
      if (frame.stack.length >= MAX_ACTION_DEPTH)
        throw new Error(`Actions nested deeper than ${MAX_ACTION_DEPTH}`);
      authorize(frame, "action", child.id, "execute");
      const outcome = await execute(child, frame, `${path}.action`);
      if (outcome.cancelled) throw new Cancelled();
      if (!outcome.ok) throw new Error(outcome.error ?? `Action ${child.name} failed`);
      return;
    }
    default:
      throw new Error(`Unknown step kind ${(step as { kind: string }).kind}`);
  }
}

function exists(config: DocumentConfig, kind: string, id: string) {
  if (!id) throw new Error(`No ${kind} selected`);
  const list: { id: string }[] | undefined =
    kind === "form"
      ? config.design?.forms
      : kind === "report"
        ? config.reports
        : kind === "dashboard"
          ? config.dashboards
          : undefined;
  if (list && !list.some((item) => item.id === id))
    throw new Error(`The ${kind} ${id} does not exist`);
}

const write = (
  operation: RecordWrite["operation"],
  table: string,
  values: RecordWrite["values"],
  identity: DataValue[] | null,
  meta: RecordWriteMeta,
): RecordWrite => ({ operation, table, values, identity, meta });

interface FoundRow {
  identity: DataValue[];
  object: Record<string, unknown>;
}

async function findRows(table: string, match: MatchSpec, frame: Frame): Promise<FoundRow[]> {
  const schema = await inspectTable(table);
  const keys = schema.columns
    .filter((c) => c.primaryKeyPosition > 0)
    .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
    .map((c) => c.name);
  let criteria: Record<string, unknown>;
  if (match === "current") {
    const record = frame.scope.record as Record<string, unknown> | null;
    if (!record) throw new Error("There is no current record");
    if (!keys.length) {
      if (record.rowid === undefined || record.rowid === null)
        throw new Error(`Table ${table} has no primary key and the record has no rowid`);
      return [{ identity: [toDataValue(record.rowid)], object: record }];
    }
    criteria = Object.fromEntries(
      keys.map((k) => {
        if (record[k] === undefined || record[k] === null)
          throw new Error(`The current record has no value for key column ${k}`);
        return [k, record[k]];
      }),
    );
  } else {
    criteria = evalMap(match, frame);
    if (!Object.keys(criteria).length) throw new Error("Match has no columns");
  }
  const filters: Filter[] = Object.entries(criteria).map(([column, value]) =>
    value === null || value === undefined
      ? { column, operator: "is_null" }
      : { column, operator: "eq", value: toDataValue(value) },
  );
  const page = await readTablePage(table, { filters, limit: 1000 });
  if (!page.rows.length) throw new Error(`No ${table} rows match`);
  return page.rows.map((row, i) => ({
    identity: page.identities[i],
    object: rowToObject(page.columns, row),
  }));
}

async function withKeys(table: string, values: Record<string, unknown>, identity: DataValue[]) {
  try {
    const keys = (await inspectTable(table)).columns
      .filter((c) => c.primaryKeyPosition > 0)
      .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
      .map((c) => c.name);
    const names = keys.length ? keys : ["rowid"];
    return {
      ...values,
      ...Object.fromEntries(names.map((k, i) => [k, fromDataValue(identity[i])])),
    };
  } catch {
    return { ...values };
  }
}

type QueryModule = {
  runSavedQuery?: (id: string, params?: Record<string, unknown>) => Promise<QueryResult>;
};

/** Runs a saved query: the Queries API when present, else the raw read path. */
export async function runQuery(
  config: DocumentConfig,
  queryId: string,
  params: Record<string, unknown>,
): Promise<QueryResult> {
  const api = queryApi as unknown as QueryModule;
  if (typeof api.runSavedQuery === "function") return api.runSavedQuery(queryId, params);
  const query = config.savedQueries.find((q) => q.id === queryId);
  if (!query) throw new Error(`Query ${queryId} does not exist`);
  if (Object.keys(params).length)
    return call<QueryResult>("execute_parameterized_query", {
      sql: query.sql,
      params: toNamedValues(params),
    });
  return executeReadQuery(query.sql);
}
