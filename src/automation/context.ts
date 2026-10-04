import type { DocumentConfig } from "../lib/types";
import type { ActionContext, NavigationTarget } from "./runner";

/**
 * Window events an interactive action context emits for hosts to handle. Run mode
 * (src/runtime/RunMode.tsx) listens and calls `preventDefault()` on events it
 * handled; an unhandled navigation is reported through `notify` instead of
 * being dropped.
 */
export const NAVIGATE_EVENT = "ixtable:navigate";
export const SET_STATE_EVENT = "ixtable:set-state";
export const DATABASE_CHANGED_EVENT = "ixtable:database-changed";

let appState: () => Record<string, unknown> = () => ({});

/** Makes `app` in browser contexts (sync triggers, custom actions) read the host's app state. */
export function provideAppState(read: () => Record<string, unknown>): () => void {
  appState = read;
  return () => {
    if (appState === read) appState = () => ({});
  };
}

/** The current app state (`app` scope) of the running application. */
export const currentAppState = () => appState();

/** Dispatches a cancelable window event; true when a host handled it. */
const handled = (name: string, detail: unknown) =>
  !window.dispatchEvent(new CustomEvent(name, { detail, cancelable: true }));

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
    app: currentAppState(),
    navigate: (target: NavigationTarget) => {
      if (!handled(NAVIGATE_EVENT, target))
        notify(`This action opens a ${target.kind}. Open it in the Runtime to follow navigation.`);
    },
    setState: (scope, key, value) => {
      handled(SET_STATE_EVENT, { scope, key, value });
    },
    confirm: async (message) => window.confirm(message),
    notify,
    refresh: () => window.dispatchEvent(new Event(DATABASE_CHANGED_EVENT)),
    ...extra,
  };
}
