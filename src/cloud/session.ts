import { useSyncExternalStore } from "react";
import type { SessionState } from "../lib/types";
import { type AssignedRole, assignRuntimeRole } from "../runtime/rbac";
import type { CloudRuntimeInfo } from "./types";

/**
 * The cloud installation open in this window, if any. Its signed manifest's
 * role becomes the only runtime role (no "preview as role" switch).
 */
let active: { sessionId: string; info: CloudRuntimeInfo } | null = null;
const listeners = new Set<() => void>();

const NO_ROLE = "cloud:no-role";

/**
 * The runtime role a signed manifest grants. Only the manifest's signed
 * `owner` flag (the app's Developer/Owner) gives developer access (null: no
 * assigned role). Any other manifest without a role maps to a role that is
 * allowed nothing (fail closed).
 */
export function runtimeRoleFor(info: CloudRuntimeInfo): AssignedRole | null {
  if (info.owner === true && info.roleId === null) return null;
  return {
    id: info.roleId ?? NO_ROLE,
    name: info.roleName ?? "Runtime user",
    permissions: {
      navigation: info.rolePermissions?.navigation ?? [],
      objects: info.rolePermissions?.objects ?? [],
      actions: info.rolePermissions?.actions ?? [],
    },
    user: { name: info.email, email: info.email, id: info.userId },
  };
}

export function setCloudRuntime(sessionId: string, info: CloudRuntimeInfo) {
  active = { sessionId, info };
  assignRuntimeRole(runtimeRoleFor(info));
  for (const listener of listeners) listener();
}

/** Clears the cloud runtime unless `sessionId` is the cloud session (App calls it on every switch). */
export function releaseCloudRuntimeUnless(sessionId: string | null | undefined) {
  if (!active || active.sessionId === sessionId) return;
  active = null;
  assignRuntimeRole(null);
  for (const listener of listeners) listener();
}

export const cloudRuntime = () => active;
export function subscribeCloudRuntime(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Asks the app frame to show another session (restore copy, runtime update). */
export const OPEN_SESSION_EVENT = "ixtable:open-session";
export const requestOpenSession = (state: SessionState) =>
  window.dispatchEvent(new CustomEvent<SessionState>(OPEN_SESSION_EVENT, { detail: state }));
export function onOpenSession(handler: (state: SessionState) => void) {
  const listener = (event: Event) => handler((event as CustomEvent<SessionState>).detail);
  window.addEventListener(OPEN_SESSION_EVENT, listener);
  return () => window.removeEventListener(OPEN_SESSION_EVENT, listener);
}

/** True when the window shows the cloud installation registered for `sessionId`. */
export function useIsCloudSession(sessionId: string) {
  return useSyncExternalStore(subscribeCloudRuntime, cloudRuntime)?.sessionId === sessionId;
}
