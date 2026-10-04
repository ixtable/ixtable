import { afterEach, describe, expect, it } from "vitest";
import { releaseCloudRuntimeUnless, setCloudRuntime, cloudRuntime } from "../../src/cloud/session";
import type { CloudRuntimeInfo } from "../../src/cloud/types";
import type { DocumentConfig } from "../../src/lib/types";
import { assignedRuntimeRole, can } from "../../src/runtime/rbac";

const config = {
  roles: [
    {
      id: "admin",
      name: "Admin",
      permissions: {
        navigation: ["nav-orders"],
        objects: [
          { kind: "form", id: "orders", read: true, create: true, update: true, delete: true },
        ],
        actions: ["approve"],
      },
    },
  ],
} as unknown as DocumentConfig;

const info = (roleId: string | null, permissions: CloudRuntimeInfo["rolePermissions"]) =>
  ({
    appId: "app",
    appName: "Orders",
    versionId: "v1",
    version: "1.0.0",
    userId: "u1",
    email: "ada@example.com",
    roleId,
    roleName: roleId ? "Sales" : null,
    rolePermissions: permissions,
    installationId: "i1",
    fingerprint: "f",
    issuedAt: "",
    expiresAt: "",
    publicKeyFingerprint: "",
    postgres: false,
    datasourceId: "",
  }) as CloudRuntimeInfo;

afterEach(() => releaseCloudRuntimeUnless(null));

describe("cloud-assigned runtime role", () => {
  it("uses the signed manifest's permissions and never developer access", () => {
    expect(can(config, null, "form", "orders", "delete")).toBe(true);
    setCloudRuntime("s1", {
      ...info("sales", {
        navigation: ["nav-orders"],
        objects: [
          { kind: "form", id: "orders", read: true, create: false, update: false, delete: false },
        ],
        actions: [],
      }),
    });
    expect(can(config, null, "form", "orders", "read")).toBe(true);
    expect(can(config, null, "form", "orders", "delete")).toBe(false);
    expect(can(config, "sales", "navigation", "nav-orders", "view")).toBe(true);
    expect(can(config, "sales", "action", "approve", "execute")).toBe(false);
    expect(can(config, "admin", "form", "orders", "delete")).toBe(false);
    expect(assignedRuntimeRole()?.user.email).toBe("ada@example.com");
  });

  it("fails closed without a role and clears when another session opens", () => {
    setCloudRuntime("s2", info(null, null));
    expect(can(config, null, "form", "orders", "read")).toBe(false);
    expect(can(config, null, "navigation", "nav-orders", "view")).toBe(false);
    releaseCloudRuntimeUnless("s2");
    expect(cloudRuntime()?.sessionId).toBe("s2");
    releaseCloudRuntimeUnless("studio-session");
    expect(cloudRuntime()).toBeNull();
    expect(can(config, null, "form", "orders", "delete")).toBe(true);
  });
});
