/**
 * Contract: the distribution journey end to end (PRD §20–§23, §25).
 * Owner creates an app, syncs roles, invites a Runtime User who accepts,
 * uploads and publishes v1; the member downloads a signed, personalized
 * bundle whose signature verifies with the pinned cloud key and whose
 * archive matches the signed checksum; the audit trail records each step in
 * order.
 */
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { devSecret, getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { grantSubscription } from "../seed";
import {
  ArchiveTracker,
  auditTrail,
  type Body,
  call,
  canonicalJson,
  publishOk,
  sha256,
} from "./distribution-fixtures";

const archives = new ArchiveTracker();
test.afterEach(() => archives.cleanup());

test("owner publishes, a member installs a signed bundle, audit records it in order", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const member = await cloud.user();
  const org = await cloud.org(owner);

  const created = await call<{
    app: { id: string; owner_id: string; head_version_id: string | null };
  }>("apps-create", owner, { orgId: org.id, name: "Journey CRM", documentId: randomUUID() });
  expect(created.status).toBe(200);
  const app = created.body.app;
  archives.add(app.id);
  expect(app.owner_id).toBe(owner.user.id);
  await grantSubscription(app.id, "starter");

  const roleId = randomUUID();
  const permissions = { pages: { all: true }, objects: { customers: ["read", "update"] } };
  const roles = await call<{ roles: { id: string; permissions: Body }[] }>("roles-sync", owner, {
    appId: app.id,
    roles: [{ id: roleId, name: "Clerk", permissions }],
  });
  expect(roles.status).toBe(200);

  const invite = await call<{ acceptUrl: string; invitation: { id: string } }>(
    "invitations-create",
    owner,
    {
      kind: "app",
      appId: app.id,
      email: member.email,
      roleId,
    },
  );
  expect(invite.status).toBe(200);
  const token = new URL(invite.body.acceptUrl).searchParams.get("token") ?? "";
  const accepted = await call("invitations-accept", member, { token });
  expect(accepted.status).toBe(200);

  const v1 = await publishOk(owner, app.id, { version: "1.0.0", expectedHeadVersionId: null });

  const installationId = randomUUID();
  const bundle = await call<{ manifest: Body; signature: string; archiveUrl: string }>(
    "bundle-manifest",
    member,
    {
      appId: app.id,
      installationId,
      deviceName: "Front desk PC",
    },
  );
  expect(bundle.status).toBe(200);
  const { manifest, signature, archiveUrl } = bundle.body;
  const publicKey = createPublicKey({
    key: Buffer.from(devSecret("IXTABLE_CLOUD_PUBLIC_KEY"), "base64"),
    format: "der",
    type: "spki",
  });
  const signatureValid = verify(
    null,
    Buffer.from(canonicalJson(manifest)),
    publicKey,
    Buffer.from(signature, "base64"),
  );
  const tampered = verify(
    null,
    Buffer.from(canonicalJson({ ...manifest, roleId: randomUUID() })),
    publicKey,
    Buffer.from(signature, "base64"),
  );
  expect(signatureValid).toBe(true);
  expect(tampered).toBe(false);
  expect(manifest).toMatchObject({
    format: "ixtable-cloud-bundle/1",
    appId: app.id,
    appName: "Journey CRM",
    versionId: v1.id,
    version: "1.0.0",
    archiveSha256: v1.archive_sha256,
    userId: member.user.id,
    roleId,
    rolePermissions: permissions,
    installationId,
  });
  expect(manifest.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  const download = await fetch(archiveUrl);
  const bytes = Buffer.from(await download.arrayBuffer());
  expect(download.status).toBe(200);
  expect(sha256(bytes)).toBe(manifest.archiveSha256);
  expect(bytes.length).toBe(manifest.archiveSize);

  const sync = await call<{ upToDate: boolean }>("sync-check", member, {
    appId: app.id,
    installedVersionId: v1.id,
    installationId,
  });
  expect(sync.body).toEqual({
    upToDate: true,
    latest: {
      versionId: v1.id,
      version: "1.0.0",
      publishedAt: expect.any(String),
      minRuntimeVersion: "0.1.0",
    },
  });
  const { data: installation } = await getServiceClient()
    .from("installations")
    .select("user_id, device_name, installed_version_id")
    .eq("id", installationId)
    .single();
  expect(installation).toEqual({
    user_id: member.user.id,
    device_name: "Front desk PC",
    installed_version_id: v1.id,
  });

  const trail = (await auditTrail(app.id)).map((row) => row.action);
  expect(trail).toEqual([
    "app.create",
    "role.sync",
    "invitation.create",
    "invitation.accept",
    "member.add",
    "archive.upload",
    "version.publish",
    "bundle.generate",
  ]);

  recordOutcome("distribution-01-signed-bundle", {
    expectations: [
      "A Runtime User who accepted an invitation gets a bundle manifest for v1 whose Ed25519 signature over canonicalJson(manifest) verifies with IXTABLE_CLOUD_PUBLIC_KEY, and a tampered manifest does not.",
      "The manifest names the member, their role and permissions, the installation and a 64-hex fingerprint; the signed archive URL returns bytes whose sha256 and size match the manifest.",
      "sync-check reports upToDate for v1 and records v1 as the installation's installed version.",
    ],
    details: {
      appId: app.id,
      versionId: v1.id,
      manifest,
      signatureValid,
      tamperedSignatureValid: tampered,
      archiveUrlOrigin: new URL(archiveUrl).origin,
      downloadStatus: download.status,
      downloadedSha256: sha256(bytes),
      installation,
    },
  });
  recordOutcome("distribution-02-audit-order", {
    expectations: [
      "The app's audit trail lists app.create, role.sync, invitation.create, invitation.accept, member.add, archive.upload, version.publish, bundle.generate in that order.",
    ],
    details: { trail },
  });
});
