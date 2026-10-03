/**
 * Contract: installation backup streams (PRD §23, §26.5 isolation of
 * per-installation backup streams). Backups need the Developer's opt-in, are
 * keyed by app/user/installation, are never merged, and one user cannot read
 * or restore another user's backups.
 */
import { randomUUID } from "node:crypto";
import { getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { addMember, createRole, grantSubscription } from "../seed";
import {
  ArchiveTracker,
  call,
  type ErrorBody,
  sha256,
  uploadArchive,
} from "./distribution-fixtures";

const archives = new ArchiveTracker();
test.afterEach(() => archives.cleanup());

type Backup = {
  backup: {
    id: string;
    user_id: string;
    installation_id: string;
    storage_path: string;
    archive_sha256: string;
  };
};

test("backup streams are isolated per user and installation", async ({ cloud }) => {
  const owner = await cloud.user();
  const alice = await cloud.user();
  const bob = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner, { backupsEnabled: true });
  archives.add(app.id);
  const role = await createRole(app.id);
  await addMember(app.id, alice.user.id, role.id);
  await addMember(app.id, bob.user.id, role.id);
  await grantSubscription(app.id, "team");

  const aliceInst = randomUUID();
  const bobInst = randomUUID();
  const commit = async (user: typeof alice, installationId: string) => {
    const upload = await uploadArchive(user, app.id, { kind: "backup", installationId });
    const result = await call<Backup & ErrorBody>("backup-commit", user, {
      appId: app.id,
      uploadId: upload.uploadId,
      installationId,
    });
    return { upload, result };
  };
  const a1 = await commit(alice, aliceInst);
  const b1 = await commit(bob, bobInst);
  // Bob tries to file his upload under Alice's installation, and to restore Alice's backup.
  const bobUpload = await uploadArchive(bob, app.id, { kind: "backup", installationId: bobInst });
  const crossCommit = await call<ErrorBody>("backup-commit", bob, {
    appId: app.id,
    uploadId: bobUpload.uploadId,
    installationId: aliceInst,
  });
  const crossUpload = await call<ErrorBody>("archive-upload-url", bob, {
    appId: app.id,
    kind: "backup",
    size: 10,
    sha256: "e".repeat(64),
    installationId: aliceInst,
  });
  const bobRestoresAlice = await call<ErrorBody>("restore-url", bob, {
    appId: app.id,
    backupId: a1.result.body.backup.id,
  });
  const aliceRestores = await call<{ signedUrl: string; sha256: string }>("restore-url", alice, {
    appId: app.id,
    backupId: a1.result.body.backup.id,
  });
  const ownerRestoresBob = await call<{ sha256: string }>("restore-url", owner, {
    appId: app.id,
    backupId: b1.result.body.backup.id,
  });
  const restoredBytes = Buffer.from(
    await (await fetch(aliceRestores.body.signedUrl)).arrayBuffer(),
  );

  const aliceSees =
    (await alice.client.from("installation_backups").select("id, user_id")).data ?? [];
  const bobSees = (await bob.client.from("installation_backups").select("id, user_id")).data ?? [];
  const ownerSees =
    (await owner.client.from("installation_backups").select("id").eq("app_id", app.id)).data ?? [];
  const versions =
    (await getServiceClient().from("app_versions").select("id").eq("app_id", app.id)).data ?? [];

  expect(a1.result.status).toBe(200);
  expect(b1.result.status).toBe(200);
  expect(a1.result.body.backup.storage_path).toBe(
    `apps/${app.id}/installations/${alice.user.id}/${aliceInst}/${a1.result.body.backup.id}.ixt`,
  );
  expect(b1.result.body.backup.storage_path).toContain(`/installations/${bob.user.id}/${bobInst}/`);
  expect(crossCommit.status).toBe(403);
  expect(crossUpload.status).toBe(403);
  expect(bobRestoresAlice.status).toBe(403);
  expect(sha256(restoredBytes)).toBe(a1.upload.sha256);
  expect(ownerRestoresBob.body.sha256).toBe(b1.upload.sha256);
  expect(aliceSees).toEqual([{ id: a1.result.body.backup.id, user_id: alice.user.id }]);
  expect(bobSees).toEqual([{ id: b1.result.body.backup.id, user_id: bob.user.id }]);
  expect(ownerSees).toHaveLength(2);
  expect(versions).toHaveLength(0);

  recordOutcome("backup-01-isolated-streams", {
    expectations: [
      "Alice's and Bob's backups land in separate streams apps/<app>/installations/<user>/<installation>/<backup>.ixt and never in app_versions (the developer stream).",
      "Bob cannot commit into or request an upload for Alice's installation (403) and cannot restore her backup (403); Alice restores her own bytes (sha256 matches) and the owner can restore Bob's.",
      "Through RLS each member lists only their own installation_backups row; the owner lists both.",
    ],
    details: {
      alicePath: a1.result.body.backup.storage_path,
      bobPath: b1.result.body.backup.storage_path,
      crossCommit: crossCommit.body,
      crossUpload: crossUpload.body,
      bobRestoresAlice: bobRestoresAlice.body,
      aliceSees,
      bobSees,
      ownerSees: ownerSees.length,
    },
  });
});

test("backups need the Developer's opt-in", async ({ cloud }) => {
  const owner = await cloud.user();
  const member = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner, { backupsEnabled: false });
  archives.add(app.id);
  const role = await createRole(app.id);
  await addMember(app.id, member.user.id, role.id);
  await grantSubscription(app.id, "team");
  const installationId = randomUUID();
  const refused = await call<ErrorBody>("archive-upload-url", member, {
    appId: app.id,
    kind: "backup",
    size: 10,
    sha256: "f".repeat(64),
    installationId,
  });
  await owner.client.from("cloud_apps").update({ backups_enabled: true }).eq("id", app.id);
  const upload = await uploadArchive(member, app.id, { kind: "backup", installationId });
  await owner.client.from("cloud_apps").update({ backups_enabled: false }).eq("id", app.id);
  const commitRefused = await call<ErrorBody>("backup-commit", member, {
    appId: app.id,
    uploadId: upload.uploadId,
    installationId,
  });

  expect(refused.status).toBe(403);
  expect(upload.putStatus).toBe(200);
  expect(commitRefused.status).toBe(403);

  recordOutcome("backup-02-opt-in", {
    expectations: [
      "With backups disabled, archive-upload-url (kind backup) and backup-commit both return 403.",
      "The owner toggles backups_enabled through RLS (a column the website may update).",
    ],
    details: { refused: refused.body, commitRefused: commitRefused.body },
  });
});
