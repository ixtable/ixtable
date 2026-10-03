import type { DocumentConfig } from "../lib/types";
import type { ActionContext, NavigationTarget } from "./runner";

/** Window events an interactive action context emits for hosts (runtime, shell) to handle. */
export const NAVIGATE_EVENT = "ixtable:navigate";
export const SET_STATE_EVENT = "ixtable:set-state";
export const DATABASE_CHANGED_EVENT = "ixtable:database-changed";

/**
 * A desktop action context: confirm uses the window dialog, navigation and state
 * changes are broadcast as window events, notify goes to `notify`.
 */
export function browserContext(
  config: DocumentConfig,
  notify: (message: string, tone?: "info" | "error") => void,
  extra: Partial<ActionContext> = {},
): ActionContext {
  return {
    config,
    app: {},
    navigate: (target: NavigationTarget) =>
      window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: target })),
    setState: (scope, key, value) =>
      window.dispatchEvent(new CustomEvent(SET_STATE_EVENT, { detail: { scope, key, value } })),
    confirm: async (message) => window.confirm(message),
    notify,
    refresh: () => window.dispatchEvent(new Event(DATABASE_CHANGED_EVENT)),
    ...extra,
  };
}
