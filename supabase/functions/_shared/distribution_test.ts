import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  backupPath,
  BUNDLE_FORMAT,
  buildManifest,
  compareSemver,
  expiredIds,
  mapDbError,
  normalizeMigrations,
  normalizeSecurity,
  publicUrl,
  versionPath,
} from "./distribution.ts";
import { HttpError } from "./http.ts";

Deno.test("compareSemver follows semver 2.0 precedence", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.2.0",
    "1.10.0",
    "2.0.0",
  ];
  for (let i = 0; i < ordered.length - 1; i++) {
    assertEquals(
      compareSemver(ordered[i], ordered[i + 1]),
      -1,
      `${ordered[i]} < ${ordered[i + 1]}`,
    );
    assertEquals(compareSemver(ordered[i + 1], ordered[i]), 1);
  }
  assertEquals(compareSemver("1.0.0+build.1", "1.0.0+build.2"), 0);
  assertThrows(() => compareSemver("1.0", "1.0.0"));
});

Deno.test("archive paths keep developer and installation streams apart", () => {
  assertEquals(versionPath("a", "v"), "apps/a/versions/v.ixt");
  assertEquals(backupPath("a", "u", "i", "b"), "apps/a/installations/u/i/b.ixt");
});

const pg = { postgres: true, concurrencyRequired: true };

Deno.test("normalizeSecurity requires confirmations for severe warnings", () => {
  const field = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      assert(err instanceof HttpError);
      assertEquals(err.code, "VALIDATION");
      return err.details?.field;
    }
    throw new Error("expected VALIDATION");
  };
  assertEquals(
    field(() => normalizeSecurity(null, pg)),
    "security",
  );
  assertEquals(
    field(() => normalizeSecurity({}, pg)),
    "security.tls",
  );
  assertEquals(
    field(() =>
      normalizeSecurity(
        { tls: false, credentialMode: "perUser", concurrencyPoliciesResolved: true },
        pg,
      ),
    ),
    "security.insecureTransportConfirmed",
  );
  assertEquals(
    field(() =>
      normalizeSecurity(
        { tls: true, credentialMode: "shared", concurrencyPoliciesResolved: true },
        pg,
      ),
    ),
    "security.sharedCredentialAcknowledged",
  );
  // A PostgreSQL summary without a mode is treated as shared.
  assertEquals(
    field(() => normalizeSecurity({ tls: true, concurrencyPoliciesResolved: true }, pg)),
    "security.sharedCredentialAcknowledged",
  );
  assertEquals(
    field(() => normalizeSecurity({ tls: true, credentialMode: "perUser" }, pg)),
    "security.concurrencyPoliciesResolved",
  );
});

Deno.test("normalizeSecurity accepts desktop preflight aliases and normalizes", () => {
  const summary = normalizeSecurity(
    {
      store: "postgres",
      tls: false,
      credentialMode: "shared",
      sslmode: "disable",
      insecureOverrideConfirmed: true,
      insecureOverrideConfirmedAt: "2026-10-03T00:00:00Z",
      sharedCredentialWarningAcknowledged: true,
      entityPoliciesResolved: true,
      extra: "dropped",
    },
    { postgres: false, concurrencyRequired: true },
  );
  assertEquals(summary, {
    store: "postgres",
    credentialMode: "shared",
    tls: false,
    sslmode: "disable",
    insecureTransportConfirmed: true,
    insecureTransportConfirmedAt: "2026-10-03T00:00:00Z",
    sharedCredentialAcknowledged: true,
    concurrencyPoliciesResolved: true,
    unresolvedEntities: [],
  });
  // SQLite single-user: nothing to confirm.
  const sqlite = normalizeSecurity({ tls: true }, { postgres: false, concurrencyRequired: false });
  assertEquals(sqlite.store, "sqlite");
  assertEquals(sqlite.credentialMode, null);
  assertEquals(sqlite.concurrencyPoliciesResolved, false);
});

Deno.test("normalizeMigrations accepts ids and {id,...} objects only", () => {
  assertEquals(normalizeMigrations(["0001", { id: "0002", name: "add" }]), [
    "0001",
    { id: "0002", name: "add" },
  ]);
  assertThrows(() => normalizeMigrations([{ name: "no id" }]), HttpError);
  assertThrows(() => normalizeMigrations([""]), HttpError);
  assertThrows(() => normalizeMigrations([42]), HttpError);
});

Deno.test("expiredIds keeps the newest N and protected items, and drops items past the age limit", () => {
  const now = new Date("2026-10-03T00:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const items = [
    { id: "d", createdAt: day(1) },
    { id: "a", createdAt: day(10), protected: true },
    { id: "c", createdAt: day(3) },
    { id: "b", createdAt: day(5) },
  ];
  assertEquals(expiredIds(items, { keep: 2, days: null, now }), ["b"]);
  assertEquals(expiredIds(items, { keep: 10, days: 2, now }), ["c", "b"]);
  assertEquals(expiredIds(items, { keep: 1, days: null, now }), ["c", "b"]);
  assertEquals(expiredIds([], { keep: 1, days: 1, now }), []);
});

Deno.test("buildManifest has exactly the bundle fields", () => {
  const issuedAt = new Date("2026-10-03T12:00:00.000Z");
  const manifest = buildManifest({
    app: { id: "app", name: "CRM" },
    version: {
      id: "v",
      version: "1.0.0",
      archive_sha256: "a".repeat(64),
      archive_size: 12,
      min_runtime_version: "0.1.0",
    },
    userId: "u",
    role: { id: "r", name: "Clerk", permissions: { pages: {} } },
    owner: false,
    installationId: "i",
    fingerprint: "f",
    issuedAt,
  });
  assertEquals(manifest, {
    format: BUNDLE_FORMAT,
    appId: "app",
    appName: "CRM",
    versionId: "v",
    version: "1.0.0",
    archiveSha256: "a".repeat(64),
    archiveSize: 12,
    minRuntimeVersion: "0.1.0",
    userId: "u",
    roleId: "r",
    roleName: "Clerk",
    rolePermissions: { pages: {} },
    owner: false,
    installationId: "i",
    fingerprint: "f",
    issuedAt: "2026-10-03T12:00:00.000Z",
    expiresAt: "2026-10-04T12:00:00.000Z",
  });
});

Deno.test("mapDbError maps distribution SQLSTATEs to the API contract", () => {
  const conflict = mapDbError({ code: "IX409", message: "moved", details: "head-id" });
  assert(conflict instanceof HttpError);
  assertEquals(
    [conflict.code, conflict.details],
    ["VERSION_CONFLICT", { headVersionId: "head-id" }],
  );
  const ent = mapDbError({ code: "IX402", message: "over_allowance" }) as HttpError;
  assertEquals([ent.code, ent.details], ["ENTITLEMENT_REQUIRED", { reason: "over_allowance" }]);
  const confirm = mapDbError({ code: "IX423", message: "confirm", details: "3" }) as HttpError;
  assertEquals(
    [confirm.code, confirm.details],
    ["VALIDATION", { requiresConfirm: true, installations: 3 }],
  );
  assertEquals((mapDbError({ code: "IX404", message: "x" }) as HttpError).code, "NOT_FOUND");
  assertEquals((mapDbError({ code: "IX403", message: "x" }) as HttpError).code, "FORBIDDEN");
  assertEquals((mapDbError({ code: "IX410", message: "x" }) as HttpError).code, "VALIDATION");
  assert(!(mapDbError({ code: "23505", message: "dup" }) instanceof HttpError));
});

Deno.test("publicUrl takes the origin from configuration, never from request headers", () => {
  const internal = "http://kong:8000/storage/v1/object/sign/app-archives/a.ixt?token=t";
  const local = { SUPABASE_URL: "http://kong:8000" };
  assertEquals(
    publicUrl(internal, local),
    "http://127.0.0.1:54321/storage/v1/object/sign/app-archives/a.ixt?token=t",
  );
  assertEquals(
    publicUrl(internal, { ...local, IXTABLE_PUBLIC_API_URL: "https://api.example.com" }),
    "https://api.example.com/storage/v1/object/sign/app-archives/a.ixt?token=t",
  );
  // A hosted project keeps Storage's public URL; an internal one is refused.
  const hosted = "https://abc.supabase.co/storage/v1/object/sign/x?token=t";
  assertEquals(publicUrl(hosted, { SUPABASE_URL: "https://abc.supabase.co" }), hosted);
  assertThrows(() => publicUrl(internal, { SUPABASE_URL: "https://abc.supabase.co" }));
  // The old header-derived origin is gone: there is no request to forge.
  assertEquals(publicUrl.length, 1);
});
