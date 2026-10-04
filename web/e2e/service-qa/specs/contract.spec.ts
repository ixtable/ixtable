/**
 * Contract fixtures: every Edge Function the desktop app and the website
 * call, in the order a real app's life uses them, against the local stack.
 * With CONTRACT_RECORD=1 the sanitized exchanges are written to
 * fixtures/contract/*.json (the inputs of the client contract tests);
 * otherwise each live response must keep the recorded shape (see
 * ../contract.ts). Re-record after an intended contract change and update
 * the clients in the same change.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getServiceClient } from "../clients";
import { ContractRecorder, RECORDING } from "../contract";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { sealSecret } from "./credentials-fixtures";
import { ArchiveTracker, SQLITE_SECURITY, uploadArchive } from "./distribution-fixtures";

const archives = new ArchiveTracker();
test.afterEach(() => archives.cleanup());

type Row = Record<string, unknown> & { id: string };

test("every client-facing function keeps its recorded contract", async ({ cloud }) => {
  test.setTimeout(120_000);
  const rec = new ContractRecorder();
  const owner = await cloud.user();
  const runtime = await cloud.user();
  const org = await cloud.org(owner);

  // Studio links a document: apps-create, roles-sync.
  const created = await rec.call<{ app: Row }>("apps-create", "apps-create", owner, {
    orgId: org.id,
    name: "Contract CRM",
    documentId: randomUUID(),
  });
  const app = created.body.app;
  cloud.trackApp(app as never);
  archives.add(app.id);
  const roleId = randomUUID();
  await rec.call("roles-sync", "roles-sync", owner, {
    appId: app.id,
    roles: [
      {
        id: roleId,
        name: "Sales",
        permissions: { navigation: ["forms"], objects: [], actions: [] },
      },
    ],
  });

  // Website billing: checkout, fake payment (webhook), portal, invoices.
  const checkout = await rec.call<{ url: string }>("billing-checkout", "billing-checkout", owner, {
    appId: app.id,
    planId: "team",
  });
  const sessionId = new URL(checkout.body.url).searchParams.get("session");
  await rec.call("billing-fake-complete", "billing-fake-complete", owner, {
    sessionId,
    appId: app.id,
    planId: "team",
  });
  await rec.call("billing-portal", "billing-portal", owner, { appId: app.id });
  await rec.call("billing-invoices", "billing-invoices", owner, { appId: app.id });

  // Studio publishes 1.0.0.
  const bytes = randomBytes(4096);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const upload = await rec.call<{ uploadId: string; signedUrl: string }>(
    "archive-upload-url",
    "archive-upload-url",
    owner,
    { appId: app.id, kind: "version", size: bytes.length, sha256 },
  );
  const put = await fetch(upload.body.signedUrl, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "x-upsert": "false" },
    body: new Uint8Array(bytes),
  });
  expect(put.status).toBe(200);
  const publishBody = {
    appId: app.id,
    uploadId: upload.body.uploadId,
    version: "1.0.0",
    releaseNotes: "First release",
    minRuntimeVersion: "0.1.0",
    migrations: [{ id: "m-0001", name: "Create customers" }],
    // The desktop sends its preflight summary plus the confirmations.
    security: {
      ...SQLITE_SECURITY,
      credentialMode: null,
      sslmode: null,
      insecureOverrideConfirmed: false,
      sharedCredentialWarning: false,
      entityPoliciesResolved: true,
      unresolvedEntities: [],
    },
    expectedHeadVersionId: null,
  };
  const published = await rec.call<{ version: Row }>(
    "publish-checkpoint",
    "publish-checkpoint",
    owner,
    publishBody,
  );
  const v1 = published.body.version;

  // Owner invites a Runtime User, who accepts on /invite.
  const invite = await rec.call<{ acceptUrl: string }>(
    "invitations-create.app",
    "invitations-create",
    owner,
    { kind: "app", appId: app.id, email: runtime.email, roleId },
  );
  await rec.call("invitations-create.org", "invitations-create", owner, {
    kind: "org",
    orgId: org.id,
    email: `contract-${randomBytes(4).toString("hex")}@example.com`,
    role: "member",
  });
  const token = new URL(invite.body.acceptUrl).searchParams.get("token");
  // The recorded acceptUrl is redacted; the live one carries the token.
  await rec.call("invitations-accept", "invitations-accept", runtime, { token });
  await rec.call("members-update", "members-update", owner, {
    appId: app.id,
    userId: runtime.user.id,
    roleId,
  });

  // Runtime installs, syncs and gets a key grant.
  const installationId = randomUUID();
  await rec.call("bundle-manifest", "bundle-manifest", runtime, {
    appId: app.id,
    installationId,
    deviceName: "Contract laptop",
  });
  await rec.call("sync-check", "sync-check", runtime, {
    appId: app.id,
    installedVersionId: v1.id,
    installationId,
  });
  const sealed = sealSecret({ v: 1, kind: "password", password: "contract" });
  await rec.call("credential-envelope", "credential-envelope", owner, {
    appId: app.id,
    datasourceId: "main",
    scope: "shared",
    ...sealed,
  });
  await rec.call("key-grant", "key-grant", runtime, {
    appId: app.id,
    installationId,
    datasourceId: "main",
  });

  // Backups (enabled by the owner in the website settings).
  await getServiceClient().from("cloud_apps").update({ backups_enabled: true }).eq("id", app.id);
  const backupUpload = await uploadArchive(runtime, app.id, { kind: "backup", installationId });
  const backup = await rec.call<{ backup: Row }>("backup-commit", "backup-commit", runtime, {
    appId: app.id,
    uploadId: backupUpload.uploadId,
    installationId,
  });
  await rec.call("restore-url.backup", "restore-url", runtime, {
    appId: app.id,
    backupId: backup.body.backup.id,
  });
  await rec.call("restore-url.version", "restore-url", owner, {
    appId: app.id,
    versionId: v1.id,
  });

  // A stale publish conflicts; Studio overwrites, the website forks.
  const stale = await uploadArchive(owner, app.id);
  const conflict = await rec.call("publish-checkpoint.409", "publish-checkpoint", owner, {
    ...publishBody,
    uploadId: stale.uploadId,
    version: "1.1.0",
    expectedHeadVersionId: randomUUID(),
  });
  expect(conflict.status).toBe(409);
  const overwritten = await rec.call<{ version: Row }>(
    "versions-resolve.overwrite",
    "versions-resolve",
    owner,
    {
      ...publishBody,
      action: "overwrite",
      uploadId: stale.uploadId,
      version: "1.1.0",
      fromVersionId: v1.id,
    },
  );
  const forked = await rec.call<{ app: Row }>("versions-resolve.fork", "versions-resolve", owner, {
    appId: app.id,
    action: "fork",
    fromVersionId: v1.id,
    name: "Contract CRM (fork)",
  });
  if (forked.body.app) cloud.trackApp(forked.body.app as never);

  // Withdraw: the head moves back to 1.0.0; withdrawing that last published
  // version while an installation runs it needs confirmation.
  await rec.call("versions-resolve.withdraw", "versions-resolve", owner, {
    appId: app.id,
    action: "withdraw",
    versionId: overwritten.body.version.id,
  });
  const unconfirmed = await rec.call("versions-resolve.withdraw.422", "versions-resolve", owner, {
    appId: app.id,
    action: "withdraw",
    versionId: v1.id,
  });
  const lastConfirmed = await rec.call(
    "versions-resolve.withdraw.confirmed",
    "versions-resolve",
    owner,
    { appId: app.id, action: "withdraw", versionId: v1.id, confirm: true },
  );

  // Website device and credential management.
  await rec.call("devices-revoke", "devices-revoke", owner, {
    appId: app.id,
    userId: runtime.user.id,
    installationId,
  });
  await rec.call("credential-delete", "credential-delete", owner, {
    appId: app.id,
    datasourceId: "main",
  });

  // Desktop sign-in hand-off (PKCE).
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  await rec.call("desktop-auth-exchange.428", "desktop-auth-exchange", null, {
    state,
    codeVerifier: verifier,
  });
  await rec.call("desktop-auth-approve", "desktop-auth-approve", owner, {
    codeChallenge: challenge,
    state,
  });
  await rec.call("desktop-auth-exchange", "desktop-auth-exchange", null, {
    state,
    codeVerifier: verifier,
  });

  // Website cancels billing, then deletion needs the explicit flag.
  await rec.call("billing-cancel", "billing-cancel", owner, { appId: app.id, atPeriodEnd: true });
  await rec.call("apps-delete.403", "apps-delete", owner, {
    appId: app.id,
    confirm: "Contract CRM",
  });
  await rec.call("apps-delete", "apps-delete", owner, {
    appId: app.id,
    confirm: "Contract CRM",
    cancelSubscription: true,
  });
  await rec.call("health", "health", null, {});

  expect(unconfirmed.status).toBe(422);
  expect(lastConfirmed.status).toBe(200);
  expect(rec.drift).toEqual([]);
  recordOutcome("contract-01-recorded-shapes", {
    expectations: [
      `${rec.names.length} client-facing exchanges ${RECORDING ? "were recorded" : "kept the recorded response shape and status"} (fixtures/contract/*.json).`,
      "Secrets in the fixtures (tokens, DEKs, ciphertext, signatures, JWTs) are placeholders of the same JSON type.",
    ],
    details: { recording: RECORDING, exchanges: rec.names, drift: rec.drift },
  });
});
