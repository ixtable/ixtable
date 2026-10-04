/**
 * Contract: bundle-manifest and sync-check access rules (PRD §21.2, §22.3).
 * Non-members get 403 FORBIDDEN, revoked members and revoked installations
 * 403 REVOKED, unentitled apps 402; an installation id cannot be taken over
 * by another user; sync-check reports newer versions.
 */
import { randomUUID } from "node:crypto";
import { getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { addMember, createRole, grantSubscription } from "../seed";
import {
  ArchiveTracker,
  auditTrail,
  call,
  type ErrorBody,
  publishOk,
} from "./distribution-fixtures";

const archives = new ArchiveTracker();
test.afterEach(() => archives.cleanup());

test("bundle-manifest refuses strangers, revoked members, revoked installations and unentitled apps", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const member = await cloud.user();
  const revoked = await cloud.user();
  const stranger = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  archives.add(app.id);
  const role = await createRole(app.id);
  await addMember(app.id, member.user.id, role.id);
  await addMember(app.id, revoked.user.id, role.id, "revoked");
  await grantSubscription(app.id, "team");
  const noVersion = await call<ErrorBody>("bundle-manifest", member, {
    appId: app.id,
    installationId: randomUUID(),
  });
  await publishOk(owner, app.id, { version: "1.0.0", expectedHeadVersionId: null });

  const ask = (user: typeof member, installationId = randomUUID()) =>
    call<ErrorBody & { manifest: Record<string, unknown> }>("bundle-manifest", user, {
      appId: app.id,
      installationId,
      deviceName: "QA",
    });
  const strangerResult = await ask(stranger);
  const revokedResult = await ask(revoked);
  const memberInstallation = randomUUID();
  const ok = await ask(member, memberInstallation);
  const ownerResult = await ask(owner);
  const hijack = await ask(owner, memberInstallation);
  await getServiceClient()
    .from("installations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", memberInstallation);
  const revokedInstallation = await ask(member, memberInstallation);
  const revokedSync = await call<ErrorBody>("sync-check", member, {
    appId: app.id,
    installationId: memberInstallation,
    installedVersionId: null,
  });
  await getServiceClient()
    .from("subscriptions")
    .update({ status: "canceled" })
    .eq("app_id", app.id);
  const unentitled = await ask(member);
  const generated = (await auditTrail(app.id)).filter(
    (row) => row.action === "bundle.generate",
  ).length;

  expect(noVersion.status).toBe(404);
  expect(strangerResult.status).toBe(403);
  expect(strangerResult.body.error.code).toBe("FORBIDDEN");
  expect(revokedResult.status).toBe(403);
  expect(revokedResult.body.error.code).toBe("REVOKED");
  expect(ok.status).toBe(200);
  expect(ownerResult.status).toBe(200);
  expect(ownerResult.body.manifest).toMatchObject({
    userId: owner.user.id,
    roleId: null,
    rolePermissions: null,
  });
  expect(hijack.status).toBe(403);
  expect(revokedInstallation.body.error.code).toBe("REVOKED");
  expect(revokedSync.body.error.code).toBe("REVOKED");
  expect(unentitled.status).toBe(402);
  expect(generated).toBe(2);

  recordOutcome("bundle-01-access", {
    expectations: [
      "A user outside the app gets 403 FORBIDDEN and a revoked member 403 REVOKED from bundle-manifest; an active member and the owner (roleId null) get a manifest.",
      "Another user cannot reuse a member's installation id (403); a revoked installation gets 403 REVOKED from bundle-manifest and sync-check.",
      "Without a published version it is 404, after the subscription is canceled 402, and only the two successful bundles are audited.",
    ],
    details: {
      noVersion: noVersion.body,
      stranger: strangerResult.body,
      revoked: revokedResult.body,
      ownerManifestRole: ownerResult.body.manifest?.roleId,
      hijack: hijack.body,
      revokedInstallation: revokedInstallation.body,
      revokedSync: revokedSync.body,
      unentitled: unentitled.body,
      bundleGenerateEvents: generated,
    },
  });
});

test("sync-check reports a newer published version", async ({ cloud }) => {
  const owner = await cloud.user();
  const member = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  archives.add(app.id);
  const role = await createRole(app.id);
  await addMember(app.id, member.user.id, role.id);
  await grantSubscription(app.id, "team");
  const v1 = await publishOk(owner, app.id, { version: "1.0.0", expectedHeadVersionId: null });
  const installationId = randomUUID();
  await call("bundle-manifest", member, { appId: app.id, installationId });
  const current = await call<{ upToDate: boolean }>("sync-check", member, {
    appId: app.id,
    installationId,
    installedVersionId: v1.id,
  });
  const v2 = await publishOk(owner, app.id, { version: "1.1.0", expectedHeadVersionId: v1.id });
  const behind = await call<{ upToDate: boolean; latest: { versionId: string; version: string } }>(
    "sync-check",
    member,
    {
      appId: app.id,
      installationId,
      installedVersionId: v1.id,
    },
  );
  const unknown = await call<ErrorBody>("sync-check", member, {
    appId: app.id,
    installationId: randomUUID(),
    installedVersionId: v1.id,
  });
  const { data: inst } = await getServiceClient()
    .from("installations")
    .select("installed_version_id")
    .eq("id", installationId)
    .single();

  expect(current.body.upToDate).toBe(true);
  expect(behind.body).toMatchObject({
    upToDate: false,
    latest: { versionId: v2.id, version: "1.1.0" },
  });
  expect(unknown.status).toBe(404);
  expect(inst?.installed_version_id).toBe(v1.id);

  recordOutcome("bundle-02-sync-check", {
    expectations: [
      "sync-check is upToDate while the installation runs the head, and after v1.1.0 is published reports upToDate false with latest 1.1.0.",
      "The installation row keeps v1 as its installed version until the Runtime reports otherwise; an unknown installation id is 404.",
    ],
    details: { current: current.body, behind: behind.body, unknown: unknown.body, installed: inst },
  });
});
