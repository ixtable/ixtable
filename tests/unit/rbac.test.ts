import { describe, expect, it } from "vitest";
import type { DocumentConfig } from "../../src/lib/types";
import { canOpen, startPage, visibleNavigation } from "../../src/runtime/navigation";
import {
  can,
  canReadDashboardQuery,
  setObjectPermission,
  toggleListed,
} from "../../src/runtime/rbac";
import type { Role } from "../../src/runtime/types";

const clerk: Role = {
  id: "clerk",
  name: "Clerk",
  permissions: {
    navigation: ["orders", "sales"],
    objects: [
      { kind: "form", id: "orders-form", read: true, create: true, update: true, delete: false },
      { kind: "table", id: "orders", read: true, create: false, update: false, delete: false },
    ],
    actions: ["approve"],
  },
};

const config = {
  roles: [clerk],
  design: {
    version: 3,
    forms: [],
    startPage: "customers",
    navigation: [
      { id: "orders", label: "Orders", kind: "form", targetId: "orders-form" },
      { id: "customers", label: "Customers", kind: "form", targetId: "customers-form" },
      {
        id: "sales",
        label: "Sales",
        kind: "group",
        children: [{ id: "hidden", label: "Report", kind: "report", targetId: "r1" }],
      },
    ],
  },
} as unknown as DocumentConfig;

describe("rbac.can", () => {
  it("gives the developer (null role) full access", () => {
    expect(can(config, null, "form", "anything", "delete")).toBe(true);
    expect(can(config, null, "action", "x", "execute")).toBe(true);
  });

  it("checks object flags, navigation, and actions for a role", () => {
    expect(can(config, "clerk", "form", "orders-form", "read")).toBe(true);
    expect(can(config, "clerk", "form", "orders-form", "view")).toBe(true);
    expect(can(config, "clerk", "form", "orders-form", "update")).toBe(true);
    expect(can(config, "clerk", "form", "orders-form", "delete")).toBe(false);
    expect(can(config, "clerk", "table", "orders", "create")).toBe(false);
    expect(can(config, "clerk", "form", "customers-form", "read")).toBe(false);
    expect(can(config, "clerk", "navigation", "orders", "view")).toBe(true);
    expect(can(config, "clerk", "navigation", "customers", "view")).toBe(false);
    expect(can(config, "clerk", "action", "approve", "execute")).toBe(true);
    expect(can(config, "clerk", "action", "approve", "read")).toBe(false);
    expect(can(config, "clerk", "action", "purge", "execute")).toBe(false);
  });

  it("lets a dashboard grant read the dashboard's queries, and nothing else", () => {
    const viewer: Role = {
      id: "viewer",
      name: "Viewer",
      permissions: {
        navigation: [],
        objects: [
          { kind: "dashboard", id: "d1", read: true, create: false, update: false, delete: false },
        ],
        actions: [],
      },
    };
    const withViewer = { ...config, roles: [clerk, viewer] } as DocumentConfig;
    expect(canReadDashboardQuery(withViewer, "viewer", "d1", "q-sales")).toBe(true);
    expect(canReadDashboardQuery(withViewer, "viewer", "d2", "q-sales")).toBe(false);
    expect(can(withViewer, "viewer", "query", "q-sales", "read")).toBe(false);
    expect(can(withViewer, "viewer", "query", "q-sales", "update")).toBe(false);
    expect(canReadDashboardQuery(withViewer, "clerk", "d1", "q-sales")).toBe(false);
    expect(canReadDashboardQuery(withViewer, null, "d1", "q-sales")).toBe(true);
  });

  it("denies unknown roles", () => {
    expect(can(config, "ghost", "form", "orders-form", "read")).toBe(false);
  });

  it("edits permission flags consistently", () => {
    let permissions = clerk.permissions;
    permissions = setObjectPermission(permissions, "report", "r1", "delete", true);
    expect(permissions.objects.at(-1)).toMatchObject({ kind: "report", read: true, delete: true });
    permissions = setObjectPermission(permissions, "report", "r1", "read", false);
    expect(permissions.objects.some((o) => o.kind === "report")).toBe(false);
    expect(toggleListed(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleListed(["a", "b"], "a", false)).toEqual(["b"]);
  });
});

describe("runtime navigation with roles", () => {
  it("hides items without view or target read, and empty groups", () => {
    expect(visibleNavigation(config.design.navigation, config, null).map((i) => i.id)).toEqual([
      "orders",
      "customers",
      "sales",
    ]);
    expect(visibleNavigation(config.design.navigation, config, "clerk").map((i) => i.id)).toEqual([
      "orders",
    ]);
  });

  it("falls back to the first visible page when the start page is hidden", () => {
    expect(startPage(config, null)).toMatchObject({ kind: "form", id: "customers-form" });
    expect(startPage(config, "clerk")).toMatchObject({ kind: "form", id: "orders-form" });
    expect(canOpen(config, "clerk", { kind: "report", id: "r1" })).toBe(false);
  });
});
