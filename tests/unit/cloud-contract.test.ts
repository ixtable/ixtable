// Desktop side of the cloud contract: the decoders in src/cloud/contract.ts,
// the error mapping and the manifest role mapping run on responses recorded
// from the local Supabase stack (web/e2e/service-qa/specs/contract.spec.ts
// writes web/e2e/service-qa/fixtures/contract/*.json).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decoders } from "../../src/cloud/contract";
import { CloudError, fromBody } from "../../src/cloud/errors";
import { runtimeRoleFor } from "../../src/cloud/session";
import type { CloudRuntimeInfo } from "../../src/cloud/types";

const DIR = join(__dirname, "..", "..", "web", "e2e", "service-qa", "fixtures", "contract");

interface Fixture {
  function: string;
  status: number;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Fixture;

describe("recorded cloud replies decode on the desktop", () => {
  it("has a fixture for every function the desktop decodes", () => {
    const recorded = new Set(readdirSync(DIR).map((file) => file.split(".")[0]));
    for (const name of Object.keys(decoders)) expect(recorded, name).toContain(name);
  });

  it("apps-create, publish-checkpoint and versions-resolve return version and app rows", () => {
    const created = decoders["apps-create"](fixture("apps-create").response);
    expect(created.app).toEqual({ id: expect.any(String), name: "Contract CRM" });

    const published = decoders["publish-checkpoint"](fixture("publish-checkpoint").response);
    expect(published.version).toMatchObject({ version: "1.0.0", status: "published" });

    const overwrite = decoders["versions-resolve"](fixture("versions-resolve.overwrite").response);
    expect(overwrite.app).toBeNull();
    expect(overwrite.version).toMatchObject({ version: "1.1.0", status: "published" });

    const fork = decoders["versions-resolve"](fixture("versions-resolve.fork").response);
    expect(fork.app?.name).toBe("Contract CRM (fork)");
    expect(fork.version?.id).toEqual(expect.any(String));
  });

  it("restore-url, sync-check and backup-commit carry what restore, update and backup read", () => {
    for (const name of ["restore-url.version", "restore-url.backup"]) {
      const target = decoders["restore-url"](fixture(name).response);
      expect(target).toEqual({
        signedUrl: expect.stringContaining("/storage/v1/object/sign/"),
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        size: expect.any(Number),
        isPostgres: false,
        warning: null,
      });
    }
    const sync = decoders["sync-check"](fixture("sync-check").response);
    expect(sync).toEqual({
      upToDate: true,
      latest: { versionId: expect.any(String), version: "1.0.0", minRuntimeVersion: "0.1.0" },
    });
    expect(decoders["sync-check"]({ upToDate: false, latest: null }).latest).toBeNull();
    const backup = decoders["backup-commit"](fixture("backup-commit").response);
    expect(backup.backup.id).toEqual(expect.any(String));
  });

  it("a reply missing a needed field fails with CLOUD_CONTRACT", () => {
    const reply = structuredClone(fixture("publish-checkpoint").response);
    delete (reply.version as Record<string, unknown>).id;
    expect(() => decoders["publish-checkpoint"](reply)).toThrow(CloudError);
    const error = (() => {
      try {
        decoders["sync-check"]({ upToDate: "yes" });
      } catch (reason) {
        return reason as CloudError;
      }
    })();
    expect(error?.code).toBe("CLOUD_CONTRACT");
    expect(error?.message).toContain("upToDate");
  });

  it("recorded error bodies keep their code and the details the UI reads", () => {
    const conflict = fixture("publish-checkpoint.409");
    const e409 = fromBody(conflict.status, conflict.response);
    expect(e409.code).toBe("VERSION_CONFLICT");
    expect(e409.details?.headVersionId).toEqual(expect.any(String));

    const pending = fixture("desktop-auth-exchange.428");
    expect(fromBody(pending.status, pending.response).code).toBe("PENDING");

    const withdraw = fixture("versions-resolve.withdraw.422");
    expect(fromBody(withdraw.status, withdraw.response).details).toEqual({
      requiresConfirm: true,
      installations: 1,
    });
  });
});

describe("signed manifest roles", () => {
  const manifest = fixture("bundle-manifest").response.manifest as Record<string, unknown>;
  const info = (overrides: Partial<CloudRuntimeInfo> = {}): CloudRuntimeInfo => ({
    appId: manifest.appId as string,
    appName: manifest.appName as string,
    versionId: manifest.versionId as string,
    version: manifest.version as string,
    userId: manifest.userId as string,
    email: "runtime@example.com",
    roleId: manifest.roleId as string,
    roleName: manifest.roleName as string,
    rolePermissions: manifest.rolePermissions as CloudRuntimeInfo["rolePermissions"],
    installationId: manifest.installationId as string,
    fingerprint: "f",
    issuedAt: manifest.issuedAt as string,
    expiresAt: manifest.expiresAt as string,
    publicKeyFingerprint: "k",
    postgres: false,
    datasourceId: "main",
    ...overrides,
  });

  it("a Runtime User gets the manifest's role name and permissions", () => {
    const role = runtimeRoleFor(info());
    expect(role).toMatchObject({
      id: manifest.roleId,
      name: "Sales",
      permissions: { navigation: ["forms"], objects: [], actions: [] },
      user: { email: "runtime@example.com", id: manifest.userId },
    });
  });

  it("only the signed owner flag gives developer access; a missing role allows nothing", () => {
    expect(manifest.owner).toBe(false);
    const owner = { roleId: null, roleName: null, rolePermissions: null, owner: true };
    expect(runtimeRoleFor(info(owner))).toBeNull();
    const noRole = runtimeRoleFor(info({ ...owner, owner: false }));
    expect(noRole?.id).toBe("cloud:no-role");
    expect(noRole?.permissions).toEqual({ navigation: [], objects: [], actions: [] });
  });
});

describe("documented contract", () => {
  it("the Contract appendix of cloud-architecture.md matches the functions", async () => {
    // @ts-expect-error -- plain ESM script without type declarations
    const { DOC, updatedDoc } = await import("../../scripts/cloud/contract-doc.mjs");
    const current = readFileSync(DOC as string, "utf8");
    expect(
      (updatedDoc as (text: string) => string)(current) === current,
      "run node scripts/cloud/contract-doc.mjs",
    ).toBe(true);
  });
});
