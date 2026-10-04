/**
 * The `customAction` concurrency policy (PRD §19): an update or delete of such an
 * entity runs the entity's configured action instead of writing the row. The
 * action decides what to write; its own record steps write directly (no
 * re-routing) under the action's onError semantics. Inserts are unaffected.
 *
 * The action runs with:
 * - `record`: the row as the caller wants it (current values with `changes`
 *   applied; the current row for a delete), so `match: current` targets it;
 * - `old`: the row before the change;
 * - `params.operation` (`update` or `delete`), `params.table`,
 *   `params.changes` (requested column values; `{}` for a delete), and
 *   `params.expected` (original values the caller started from, or null).
 * A `match: current` step on the routed row sends those original values (else the
 * row as read when the write began) as its `expected`, not a fresh read.
 * The action runs under the user's role (which must be allowed to run it), and Rust
 * authorizes each of its writes like any other record write.
 */
import type { RecordWrite } from "../lib/records";
import { setRecordRouter } from "../lib/records";
import type { DocumentConfig, NamedValue } from "../lib/types";
import { expectedOf } from "./rows";
import { runAction } from "./runner";
import type { TriggerEnv } from "./triggers";
import { readRow } from "./triggers";
import type { ActionDef } from "./types";
import { namedToObject } from "./values";

/** The action a `customAction` entity routes its updates and deletes to, if any. */
export function customActionFor(config: DocumentConfig, table: string): ActionDef | null {
  const entity = (config.entities ?? []).find((e) => e.table === table);
  if (entity?.concurrency !== "customAction") return null;
  const action = config.actions.find((a) => a.id === entity.actionId);
  if (!action)
    throw new Error(`${table} uses a custom concurrency action, but its action does not exist`);
  return action;
}

export interface CustomRequest {
  operation: "update" | "delete";
  table: string;
  values: NamedValue[];
  old: Record<string, unknown>;
  expected?: NamedValue[];
}

/** The `record`, `old`, and `params` a custom action runs with. */
export function customScope(request: CustomRequest) {
  const changes = request.operation === "update" ? namedToObject(request.values) : {};
  return {
    record: { ...request.old, ...changes },
    old: request.old,
    params: {
      operation: request.operation,
      table: request.table,
      changes,
      expected: request.expected ? namedToObject(request.expected) : null,
    },
  };
}

/** Routes updates and deletes of custom-action entities (forms, grids) to their action. */
export function installCustomActions(env: TriggerEnv): () => void {
  return setRecordRouter((write: RecordWrite) => {
    if (write.operation === "insert" || !write.identity) return undefined;
    const action = customActionFor(env.getConfig(), write.table);
    if (!action) return undefined;
    return runCustom(action, write, env);
  });
}

async function runCustom(action: ActionDef, write: RecordWrite, env: TriggerEnv) {
  const old = write.meta?.old ?? (await readRow(write.table, write.identity ?? []));
  if (!old) throw new Error(`The ${write.table} record no longer exists`);
  const scope = customScope({
    operation: write.operation as CustomRequest["operation"],
    table: write.table,
    values: write.values,
    old,
    expected: write.meta?.expected,
  });
  // `match: current` writes against the caller's snapshot, so a concurrent change raises CONFLICT.
  const expected = write.meta?.expected ?? (await expectedOf(write.table, old));
  const outcome = await runAction(
    action,
    env.context({
      ...scope,
      triggerDepth: write.meta?.triggerDepth ?? 0,
      directWrites: true,
      snapshot: old,
      current: { table: write.table, identity: write.identity ?? [], expected },
    }),
  );
  if (!outcome.ok) throw new Error(outcome.error ?? `Action ${action.name} failed`);
  return 1;
}
