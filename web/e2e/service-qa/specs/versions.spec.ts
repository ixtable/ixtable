/**
 * Contract: versions-resolve (PRD §22.4: explicit overwrite or fork) and
 * restore-url (PRD §23: restore to a new local copy; PostgreSQL warning).
 */
import { getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { addMember, createRole, grantSubscription } from "../seed";
import {
  ArchiveTracker,
  auditTrail,
  call,
  type ErrorBody,
  objectExists,
  publish,
  publishOk,
  SQLITE_SECURITY,
  sha256,
  uploadArchive,
  type VersionRow,
} from "./distribution-fixtures";

const archives = new ArchiveTracker();
test.afterEach(() => archives.cleanup());

test("a diverged archive is resolved by explicit overwrite or fork", async ({ cloud }) => {
  const owner = await cloud.user();
  const org = await cloud.org(owner);
  const app = await cloud.app(org, owner);
  archives.add(app.id);
  await createRole(app.id, { name: "Clerk" });
  await grantSubscription(app.id, "team");
  const v1 = await publishOk(owner, app.id, { version: "1.0.0", expectedHeadVersionId: null });
  // Another device published 1.1.0; this device still bases on v1.
  const v2 = await publishOk(owner, app.id, { version: "1.1.0", expectedHeadVersionId: v1.id });
  const diverged = await publish(owner, app.id, { version: "1.2.0", expectedHeadVersionId: v1.id });
  expect(diverged.result.status).toBe(409);
  const headFromConflict = diverged.result.body.error.details?.headVersionId as string;

  const publishFields = {
    appId: app.id,
    uploadId: diverged.upload?.uploadId,
    version: "1.2.0",
    releaseNotes: "Local changes win",
    minRuntimeVersion: "0.1.0",
    migrations: [],
    security: SQLITE_SECURITY,
  };
  const staleOverwrite = await call<ErrorBody>("versions-resolve", owner, {
    ...publishFields,
    action: "overwrite",
    fromVersionId: v1.id,
  });
  const overwrite = await call<{ version: VersionRow }>("versions-resolve", owner, {
    ...publishFields,
    action: "overwrite",
    fromVersionId: headFromConflict,
  });
  expect(staleOverwrite.status).toBe(409);
  expect(overwrite.status).toBe(200);
  expect(overwrite.body.version).toMatchObject({
    version: "1.2.0",
    resolution: "overwrite",
    parent_version_id: v2.id,
    archive_sha256: diverged.upload?.sha256,
  });

  // Fork from a fresh diverged upload: a new app owned by the caller.
  const forkUpload = await uploadArchive(owner, app.id);
  const fork = await call<{
    app: { id: string; owner_id: string; org_id: string; head_version_id: string; name: string };
    version: VersionRow;
  }>("versions-resolve", owner, {
    ...publishFields,
    uploadId: forkUpload.uploadId,
    version: "2.0.0",
    action: "fork",
    fromVersionId: overwrite.body.version.id,
    name: "CRM experiment",
  });
  expect(fork.status).toBe(200);
  archives.add(fork.body.app.id);
  // Fork copying a published cloud version (no upload).
  const copy = await call<{ app: { id: string; head_version_id: string }; version: VersionRow }>(
    "versions-resolve",
    owner,
    {
      appId: app.id,
      action: "fork",
      fromVersionId: v1.id,
    },
  );
  expect(copy.status).toBe(200);
  archives.add(copy.body.app.id);

  const admin = getServiceClient();
  const { data: source } = await admin
    .from("cloud_apps")
    .select("head_version_id")
    .eq("id", app.id)
    .single();
  const { data: forkRoles } = await admin
    .from("app_roles")
    .select("name")
    .eq("app_id", fork.body.app.id);
  const copyBytes = Buffer.from(
    await (
      await admin.storage.from("app-archives").download(copy.body.version.storage_path)
    ).data!.arrayBuffer(),
  );
  expect(source?.head_version_id).toBe(overwrite.body.version.id);
  expect(fork.body.app).toMatchObject({
    owner_id: owner.user.id,
    org_id: org.id,
    name: "CRM experiment",
    head_version_id: fork.body.version.id,
  });
  expect(fork.body.version).toMatchObject({
    app_id: fork.body.app.id,
    version: "2.0.0",
    resolution: "fork",
    archive_sha256: forkUpload.sha256,
    storage_path: `apps/${fork.body.app.id}/versions/${fork.body.version.id}.ixt`,
  });
  expect(await objectExists(fork.body.version.storage_path)).toBe(true);
  expect(await objectExists(forkUpload.path)).toBe(false);
  expect(forkRoles).toEqual([{ name: "Clerk" }]);
  expect(copy.body.version).toMatchObject({
    version: "1.0.0",
    parent_version_id: v1.id,
    resolution: "fork",
    archive_sha256: v1.archive_sha256,
  });
  expect(sha256(copyBytes)).toBe(v1.archive_sha256);
  const trail = (await auditTrail(app.id))
    .map((row) => row.action)
    .filter((a) => a.startsWith("version."));
  const forkTrail = (await auditTrail(fork.body.app.id)).map((row) => row.action);
  expect(trail).toEqual([
    "version.publish",
    "version.publish",
    "version.overwrite",
    "version.fork",
    "version.fork",
  ]);
  expect(forkTrail).toEqual(["app.create", "version.fork"]);

  recordOutcome("versions-01-overwrite", {
    expectations: [
      "After a 409, versions-resolve overwrite with the head from the conflict publishes the diverged upload as the new head (resolution overwrite, parent = overwritten head); a stale fromVersionId is 409 again.",
    ],
    details: {
      conflict: diverged.result.body,
      staleOverwrite: staleOverwrite.body,
      overwrite: overwrite.body.version,
      sourceHead: source?.head_version_id,
    },
  });
  recordOutcome("versions-02-fork", {
    expectations: [
      "Fork from an upload creates a new app in the same org owned by the caller, with the source roles copied and the archive moved to apps/<newApp>/versions/<id>.ixt as its published head.",
      "Fork from a published version copies that archive (same sha256) into a new app with parent = the source version.",
      "Audit: the source app records version.overwrite then version.fork twice; the fork records app.create then version.fork.",
    ],
    details: { fork: fork.body, copy: copy.body, forkRoles, sourceTrail: trail, forkTrail },
  });
});

test("restore-url: owner-only versions, PostgreSQL warning", async ({ cloud }) => {
  const owner = await cloud.user();
  const member = await cloud.user();
  const pgApp = await cloud.app(await cloud.org(owner), owner, { datasourceKind: "postgres" });
  archives.add(pgApp.id);
  const role = await createRole(pgApp.id);
  await addMember(pgApp.id, member.user.id, role.id);
  await grantSubscription(pgApp.id, "team");
  const upload = await uploadArchive(owner, pgApp.id);
  const { result } = await publish(owner, pgApp.id, {
    version: "1.0.0",
    expectedHeadVersionId: null,
    uploadId: upload.uploadId,
    security: {
      store: "postgres",
      tls: true,
      credentialMode: "perUser",
      concurrencyPoliciesResolved: true,
    },
  });
  // Fail here, with the server's answer, if the setup publish did not succeed
  // (a failed PUT or publish otherwise surfaces later as "version is null").
  expect(upload.putStatus, "archive PUT to the signed upload URL").toBe(200);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const version = result.body.version;

  const restore = await call<{
    signedUrl: string;
    sha256: string;
    size: number;
    isPostgres: boolean;
    warning: string;
  }>("restore-url", owner, { appId: pgApp.id, versionId: version.id });
  const byMember = await call<ErrorBody>("restore-url", member, {
    appId: pgApp.id,
    versionId: version.id,
  });
  const both = await call<ErrorBody>("restore-url", owner, {
    appId: pgApp.id,
    versionId: version.id,
    backupId: version.id,
  });
  const bytes = Buffer.from(await (await fetch(restore.body.signedUrl)).arrayBuffer());
  const trail = (await auditTrail(pgApp.id)).map((row) => row.action);

  expect(restore.status).toBe(200);
  expect(restore.body).toMatchObject({
    sha256: upload.sha256,
    size: upload.bytes.length,
    isPostgres: true,
    warning: "Restoring this archive does not restore external PostgreSQL records.",
  });
  expect(sha256(bytes)).toBe(upload.sha256);
  expect(byMember.status).toBe(403);
  expect(both.status).toBe(422);
  expect(trail.at(-1)).toBe("version.restore");

  recordOutcome("versions-03-restore-postgres", {
    expectations: [
      "restore-url for a PostgreSQL app's version returns a working signed URL (bytes match sha256), isPostgres true and the warning 'Restoring this archive does not restore external PostgreSQL records.'",
      "A Runtime User cannot get a version restore URL (403); naming both versionId and backupId is 422.",
      "The restore is audited as version.restore.",
    ],
    details: {
      restore: { ...restore.body, signedUrl: new URL(restore.body.signedUrl).pathname },
      byMember: byMember.body,
      both: both.body,
      lastAudit: trail.at(-1),
    },
  });
});

test("withdraw rolls the head back and guards the last installed version", async ({ cloud }) => {
  const owner = await cloud.user();
  const member = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  archives.add(app.id);
  const role = await createRole(app.id);
  await addMember(app.id, member.user.id, role.id);
  await grantSubscription(app.id, "team");
  const v1 = await publishOk(owner, app.id, { version: "1.0.0", expectedHeadVersionId: null });
  const v2 = await publishOk(owner, app.id, { version: "1.1.0", expectedHeadVersionId: v1.id });
  const installationId = crypto.randomUUID();
  await call("bundle-manifest", member, { appId: app.id, installationId, deviceName: "QA" });
  await call("sync-check", member, { appId: app.id, installationId, installedVersionId: v1.id });

  const byMember = await call<ErrorBody>("versions-resolve", member, {
    appId: app.id,
    action: "withdraw",
    versionId: v2.id,
  });
  const rollback = await call<{ version: VersionRow; headVersionId: string }>(
    "versions-resolve",
    owner,
    {
      appId: app.id,
      action: "withdraw",
      versionId: v2.id,
    },
  );
  const sync = await call<{ upToDate: boolean; latest: { versionId: string } }>(
    "sync-check",
    member,
    {
      appId: app.id,
      installationId,
      installedVersionId: v1.id,
    },
  );
  const guarded = await call<ErrorBody>("versions-resolve", owner, {
    appId: app.id,
    action: "withdraw",
    versionId: v1.id,
  });
  const confirmed = await call<{ headVersionId: string | null; dependentInstallations: number }>(
    "versions-resolve",
    owner,
    {
      appId: app.id,
      action: "withdraw",
      versionId: v1.id,
      confirm: true,
    },
  );
  const again = await call<ErrorBody>("versions-resolve", owner, {
    appId: app.id,
    action: "withdraw",
    versionId: v1.id,
  });
  const { data: appRow } = await getServiceClient()
    .from("cloud_apps")
    .select("head_version_id")
    .eq("id", app.id)
    .single();
  const withdrawals = (await auditTrail(app.id)).filter(
    (row) => row.action === "version.withdraw",
  ).length;

  expect(byMember.status).toBe(403);
  expect(rollback.status).toBe(200);
  expect(rollback.body.version.status).toBe("withdrawn");
  expect(rollback.body.headVersionId).toBe(v1.id);
  expect(sync.body).toMatchObject({ upToDate: true, latest: { versionId: v1.id } });
  expect(guarded.status).toBe(422);
  expect(guarded.body.error.details).toEqual({ requiresConfirm: true, installations: 1 });
  expect(confirmed.status).toBe(200);
  expect(confirmed.body).toMatchObject({ headVersionId: null, dependentInstallations: 1 });
  expect(again.status).toBe(422);
  expect(appRow?.head_version_id).toBeNull();
  expect(withdrawals).toBe(2);

  recordOutcome("versions-04-withdraw", {
    expectations: [
      "Withdrawing the head v1.1.0 (owner only; a Runtime User gets 403) marks it withdrawn and moves the head back to v1.0.0, so an installation on v1.0.0 is up to date.",
      "Withdrawing v1.0.0, the last published version an installation runs, is refused with 422 {requiresConfirm, installations:1} until confirm:true, which leaves no head.",
      "Each withdrawal is audited as version.withdraw; withdrawing an already withdrawn version is 422.",
    ],
    details: {
      byMember: byMember.body,
      rollback: rollback.body,
      sync: sync.body,
      guarded: guarded.body,
      confirmed: confirmed.body,
      again: again.body,
      head: appRow?.head_version_id,
      withdrawals,
    },
  });
});
