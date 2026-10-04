/**
 * Contract: retention-sweep (PRD §23 retention policy). Runs only with the
 * service role key (or CRON_SECRET); deletes storage objects and rows beyond
 * the app's retention, never the head or an installed version, and keeps the
 * newest backup of every installation.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { callFunction, getServiceClient, localStack } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { addMember, createRole, grantSubscription } from "../seed";
import {
  ArchiveTracker,
  auditTrail,
  call,
  type ErrorBody,
  objectExists,
  publishOk,
  uploadArchive,
} from "./distribution-fixtures";

const archives = new ArchiveTracker();
test.afterEach(() => archives.cleanup());

type Sweep = {
  deleted: number;
  versions: number;
  backups: number;
  uploads: number;
  desktopAuthRequests: number;
};

test("retention keeps the head, installed versions and each installation's newest backup", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const member = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner, { backupsEnabled: true });
  archives.add(app.id);
  const role = await createRole(app.id);
  await addMember(app.id, member.user.id, role.id);
  await grantSubscription(app.id, "team");
  const admin = getServiceClient();
  await admin.from("cloud_apps").update({ retention_versions: 1 }).eq("id", app.id);

  const v1 = await publishOk(owner, app.id, { version: "1.0.0", expectedHeadVersionId: null });
  const v2 = await publishOk(owner, app.id, { version: "1.1.0", expectedHeadVersionId: v1.id });
  const v3 = await publishOk(owner, app.id, { version: "1.2.0", expectedHeadVersionId: v2.id });
  const installationId = randomUUID();
  await call("bundle-manifest", member, { appId: app.id, installationId });
  await call("sync-check", member, { appId: app.id, installationId, installedVersionId: v1.id });
  const backups: string[] = [];
  for (let i = 0; i < 3; i++) {
    const upload = await uploadArchive(member, app.id, { kind: "backup", installationId });
    const commit = await call<{ backup: { id: string; storage_path: string } }>(
      "backup-commit",
      member,
      {
        appId: app.id,
        uploadId: upload.uploadId,
        installationId,
      },
    );
    backups.push(commit.body.backup.id);
  }
  const { data: backupRows } = await admin
    .from("installation_backups")
    .select("id, storage_path")
    .in("id", backups);
  const pathOf = (id: string) => backupRows?.find((row) => row.id === id)?.storage_path as string;

  const anonymous = await callFunction<ErrorBody>("retention-sweep", { body: { appId: app.id } });
  const asMember = await call<ErrorBody>("retention-sweep", member, { appId: app.id });
  const sweep = await callFunction<Sweep>("retention-sweep", {
    jwt: localStack().serviceRoleKey,
    body: { appId: app.id },
  });
  const { data: remaining } = await admin.from("app_versions").select("id").eq("app_id", app.id);
  const { data: remainingBackups } = await admin
    .from("installation_backups")
    .select("id")
    .eq("app_id", app.id);
  const event = (await auditTrail(app.id)).find((row) => row.action === "retention.sweep");

  expect(anonymous.status).toBe(401);
  expect(asMember.status).toBe(403);
  expect(sweep.status).toBe(200);
  expect(sweep.body).toMatchObject({ deleted: 3, versions: 1, backups: 2 });
  expect((remaining ?? []).map((row) => row.id).sort()).toEqual([v1.id, v3.id].sort());
  expect(await objectExists(v2.storage_path)).toBe(false);
  expect(await objectExists(v3.storage_path)).toBe(true);
  expect(await objectExists(v1.storage_path)).toBe(true);
  expect(remainingBackups).toEqual([{ id: backups[2] }]);
  expect(await objectExists(pathOf(backups[0]))).toBe(false);
  expect(await objectExists(pathOf(backups[2]))).toBe(true);
  expect(event?.details).toMatchObject({
    versions: [v2.id],
    backups: expect.arrayContaining([backups[0], backups[1]]),
  });

  recordOutcome("retention-01-sweep", {
    expectations: [
      "With retention_versions 1, the sweep deletes v1.1.0 (row and storage object) but keeps the head v1.2.0 and v1.0.0, which an installation reports as installed.",
      "Of three backups in one installation stream only the newest remains; the two older objects are removed from storage.",
      "Only the service role may sweep (no auth 401, a user JWT 403); the deletion is audited as retention.sweep with the deleted ids.",
    ],
    details: {
      anonymous: anonymous.body,
      asMember: asMember.body,
      sweep: sweep.body,
      remaining,
      remainingBackups,
      audit: event?.details,
    },
  });
});

test("a full sweep removes expired desktop sign-in requests", async () => {
  const admin = getServiceClient();
  const state = `qa-${randomBytes(12).toString("hex")}`;
  const { error } = await admin.from("desktop_auth_requests").insert({
    state,
    code_challenge: randomBytes(32).toString("base64url"),
    expires_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  });
  expect(error).toBeNull();
  const sweep = await callFunction<Sweep>("retention-sweep", {
    jwt: localStack().serviceRoleKey,
    body: {},
  });
  const { data } = await admin.from("desktop_auth_requests").select("id").eq("state", state);

  expect(sweep.status).toBe(200);
  expect(sweep.body.desktopAuthRequests).toBeGreaterThanOrEqual(1);
  expect(data).toEqual([]);

  recordOutcome("retention-02-desktop-auth-requests", {
    expectations: [
      "A full retention sweep (no appId) deletes desktop_auth_requests rows that expired more than an hour ago.",
    ],
    details: { sweep: sweep.body, remaining: data },
  });
});
