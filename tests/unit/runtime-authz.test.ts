import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => {
    throw new Error("no backend in this test");
  },
}));

const { activeRoleId, assignRuntimeRole, authorizer, setPreviewedRole } = await import(
  "../../src/runtime/rbac"
);
const { headlessContext } = await import("../../src/automation/worker");

const role = (id: string, actions: string[]) => ({
  id,
  name: id,
  permissions: { navigation: [], objects: [], actions },
});
const config = { roles: [role("clerk", ["approve"]), role("viewer", [])] };

afterEach(() => {
  setPreviewedRole(null);
  assignRuntimeRole(null);
});

describe("automation authorization", () => {
  it("follows the active role: developer, Studio preview, then the cloud-assigned role", () => {
    const authorize = authorizer(config);
    expect(activeRoleId()).toBeNull();
    expect(authorize("action", "purge", "execute")).toBe(true);
    setPreviewedRole("clerk");
    expect(activeRoleId()).toBe("clerk");
    expect(authorize("action", "approve", "execute")).toBe(true);
    expect(authorize("action", "purge", "execute")).toBe(false);
    assignRuntimeRole({ ...role("viewer", []), user: { name: "Ada" } });
    expect(activeRoleId()).toBe("viewer");
    expect(authorize("action", "approve", "execute")).toBe(false);
  });

  it("never lets a background job exceed the role it was created under", () => {
    const ctx = (roleId: string | null) =>
      headlessContext(config as never, { roleId, triggerDepth: 1 }, {}, []);
    expect(ctx(null).authorize?.("action", "approve", "execute")).toBe(true);
    expect(ctx("clerk").authorize?.("action", "approve", "execute")).toBe(true);
    expect(ctx("viewer").authorize?.("action", "approve", "execute")).toBe(false);
    setPreviewedRole("viewer");
    expect(ctx("clerk").authorize?.("action", "approve", "execute")).toBe(false);
  });
});
