import type { DocumentConfig } from "../lib/types";
import type { ObjectKind, Operation, Permissions, Role } from "./types";

const emptyPermissions = (): Permissions => ({ navigation: [], objects: [], actions: [] });

/** A runtime role assigned by ixtable Cloud (signed manifest), with the signed-in user. */
export type AssignedRole = Role & { user: { name: string; email?: string; id?: string } };
let assigned: AssignedRole | null = null;

/**
 * Pins the runtime to a cloud-assigned role (PRD §20, §21.2): while set, every
 * check uses it, `roleId` null no longer means developer access, and the
 * role's permissions come from the signed manifest, not the archive.
 */
export function assignRuntimeRole(role: AssignedRole | null) {
  assigned = role;
}
export const assignedRuntimeRole = () => assigned;

export const findRole = (config: Pick<DocumentConfig, "roles">, roleId: string | null) => {
  if (assigned) return roleId == null || roleId === assigned.id ? assigned : undefined;
  return roleId == null ? null : (config.roles ?? []).find((role) => role.id === roleId);
};

const permissionsOf = (role: Role): Permissions => ({
  ...emptyPermissions(),
  ...role.permissions,
});

/**
 * Runtime RBAC check (PRD §20). `roleId` null is the developer: full access.
 * Unknown roles are denied everything. Kinds:
 * - `navigation` + `view`: the item id is listed in the role's navigation.
 * - `action` + `execute`: the action id is listed in the role's actions.
 * - form/report/dashboard/table/query + read/create/update/delete (`view` = read).
 */
export function can(
  config: Pick<DocumentConfig, "roles">,
  roleId: string | null,
  objectKind: ObjectKind | "navigation" | "action" | string,
  objectId: string,
  op: Operation,
): boolean {
  if (roleId == null && !assigned) return true;
  const role = findRole(config, roleId);
  if (!role) return false;
  const permissions = permissionsOf(role);
  if (objectKind === "navigation") return permissions.navigation.includes(objectId);
  if (objectKind === "action") return op === "execute" && permissions.actions.includes(objectId);
  const entry = permissions.objects.find(
    (item) => item.kind === objectKind && item.id === objectId,
  );
  if (!entry) return false;
  const flag = op === "view" ? "read" : op;
  if (flag === "execute") return false;
  return entry[flag] === true;
}

/** Error thrown when a runtime write or action is attempted without permission. */
export class PermissionError extends Error {
  readonly code = "FORBIDDEN";
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

/** Returns `permissions` with one object flag set, adding the object entry when missing. */
export function setObjectPermission(
  permissions: Permissions,
  kind: ObjectKind,
  id: string,
  flag: "read" | "create" | "update" | "delete",
  value: boolean,
): Permissions {
  const existing = permissions.objects.find((item) => item.kind === kind && item.id === id);
  const base = existing ?? { kind, id, read: false, create: false, update: false, delete: false };
  const next = { ...base, [flag]: value };
  if (flag !== "read" && value) next.read = true;
  if (flag === "read" && !value)
    Object.assign(next, { create: false, update: false, delete: false });
  const objects = existing
    ? permissions.objects.map((item) => (item === existing ? next : item))
    : [...permissions.objects, next];
  return {
    ...permissions,
    objects: objects.filter((o) => o.read || o.create || o.update || o.delete),
  };
}

/** Adds or removes `id` in a navigation/actions list. */
export const toggleListed = (list: string[], id: string, on: boolean) =>
  on ? [...new Set([...list, id])] : list.filter((item) => item !== id);
