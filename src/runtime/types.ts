/** Mirrors `src-tauri/src/roles.rs`. Local role definitions (PRD §20); cloud membership is out of scope. */
export type ObjectKind = "form" | "report" | "dashboard" | "table" | "query";
export const OBJECT_KINDS: ObjectKind[] = ["form", "report", "dashboard", "table", "query"];

export interface ObjectPermission {
  kind: ObjectKind;
  id: string;
  read: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
}

export interface Permissions {
  /** Navigation item ids the role can see. */
  navigation: string[];
  objects: ObjectPermission[];
  /** Action ids the role can execute. */
  actions: string[];
}

export interface Role {
  id: string;
  name: string;
  permissions: Permissions;
}

export type Operation = "read" | "create" | "update" | "delete" | "execute" | "view";
