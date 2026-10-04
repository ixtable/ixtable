import type { Step } from "../automation/types";
import type { DocumentConfig } from "../lib/types";
import { can } from "./rbac";
import type { Operation } from "./types";

type Needed = { kind: string; id: string; op: Operation };

/** Permissions a trigger's action needs, following branches and runAction calls. */
function needed(config: Pick<DocumentConfig, "actions">, actionId: string): Needed[] {
  const out: Needed[] = [{ kind: "action", id: actionId, op: "execute" }];
  const seen = new Set<string>();
  const queue = [actionId];
  while (queue.length) {
    const id = queue.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const steps: Step[] = [...((config.actions ?? []).find((a) => a.id === id)?.steps ?? [])];
    while (steps.length) {
      const step = steps.pop() as Step;
      if (step.kind === "condition") steps.push(...(step.then ?? []), ...(step.else ?? []));
      if (step.kind === "createRecord") out.push({ kind: "table", id: step.table, op: "create" });
      if (step.kind === "updateRecord") out.push({ kind: "table", id: step.table, op: "update" });
      if (step.kind === "deleteRecord") out.push({ kind: "table", id: step.table, op: "delete" });
      if (step.kind === "runQuery") out.push({ kind: "query", id: step.queryId, op: "read" });
      if (step.kind === "runAction") {
        out.push({ kind: "action", id: step.actionId, op: "execute" });
        queue.push(step.actionId);
      }
    }
  }
  return out;
}

export interface TriggerGap {
  triggerId: string;
  name: string;
  missing: string[];
}

/**
 * Enabled "run as signed-in user" triggers whose steps `roleId` cannot perform
 * (Rust refuses the initiating save for that role). Explicit grants only, so the
 * warning may also list access a form grant would imply.
 */
export function userTriggerGaps(
  config: Pick<DocumentConfig, "roles" | "actions" | "triggers">,
  roleId: string,
): TriggerGap[] {
  return (config.triggers ?? [])
    .filter((t) => t.enabled && t.runAs === "user")
    .map((t) => {
      const missing = needed(config, t.actionId)
        .filter((n) => !can(config, roleId, n.kind, n.id, n.op))
        .map((n) => `${n.op} ${n.kind} ${n.id}`);
      return { triggerId: t.id, name: t.name, missing: [...new Set(missing)] };
    })
    .filter((gap) => gap.missing.length > 0);
}
