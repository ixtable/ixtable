/**
 * Contract: archive-upload-url + publish-checkpoint (PRD §7.4, §19, §21.4,
 * §22.2). Uploads are signed, ≤500 MB and single use; publishing is explicit,
 * owner-only and entitled; the head precondition returns 409
 * VERSION_CONFLICT; versions increase; the security summary must confirm
 * severe warnings.
 */
import { getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { addMember, createRole, grantSubscription } from "../seed";
import {
  ArchiveTracker,
  call,
  type ErrorBody,
  fakeArchive,
  objectExists,
  publish,
  publishOk,
  SQLITE_SECURITY,
  uploadArchive,
} from "./distribution-fixtures";

const archives = new ArchiveTracker();
test.afterEach(() => archives.cleanup());

test("publish moves the head; stale expectedHeadVersionId is 409 VERSION_CONFLICT", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  archives.add(app.id);
  await grantSubscription(app.id, "team");

  const first = await publish(owner, app.id, {
    version: "1.0.0",
    expectedHeadVersionId: null,
    migrations: [{ id: "0001", name: "create customers" }],
  });
  expect(first.result.status).toBe(200);
  const v1 = first.result.body.version;
  const v2 = await publishOk(owner, app.id, { version: "1.1.0", expectedHeadVersionId: v1.id });
  const stale = await publish(owner, app.id, { version: "1.2.0", expectedHeadVersionId: v1.id });
  const notGreater = await publish(owner, app.id, {
    version: "1.1.0",
    expectedHeadVersionId: v2.id,
  });
  const reuse = await publish(owner, app.id, {
    version: "1.3.0",
    expectedHeadVersionId: v2.id,
    uploadId: first.upload?.uploadId,
  });

  const admin = getServiceClient();
  const { data: appRow } = await admin
    .from("cloud_apps")
    .select("head_version_id")
    .eq("id", app.id)
    .single();
  const { data: upload } = await admin
    .from("archive_uploads")
    .select("status, committed_at")
    .eq("id", first.upload?.uploadId)
    .single();
  const { count: staleRows } = await admin
    .from("app_versions")
    .select("id", { count: "exact", head: true })
    .eq("app_id", app.id);

  expect(v1).toMatchObject({
    version: "1.0.0",
    status: "published",
    archive_sha256: first.upload?.sha256,
    archive_size: 2048,
    storage_path: `apps/${app.id}/versions/${v1.id}.ixt`,
    migrations: [{ id: "0001", name: "create customers" }],
  });
  expect(await objectExists(v1.storage_path)).toBe(true);
  expect(v2.parent_version_id).toBe(v1.id);
  expect(stale.result.status).toBe(409);
  expect(stale.result.body.error).toMatchObject({
    code: "VERSION_CONFLICT",
    details: { headVersionId: v2.id },
  });
  expect(notGreater.result.status).toBe(422);
  expect(reuse.result.status).toBe(422);
  expect(appRow?.head_version_id).toBe(v2.id);
  expect(upload?.status).toBe("committed");
  expect(staleRows).toBe(2);

  recordOutcome("publish-01-head-and-conflict", {
    expectations: [
      "Publishing v1 (expectedHeadVersionId null) then v1.1.0 (expected v1) creates two published, immutable versions with the uploaded sha256/size, storage path apps/<app>/versions/<id>.ixt and the migrations list; the head is v1.1.0.",
      "Publishing with the stale head v1 returns 409 VERSION_CONFLICT naming the current head; nothing is written.",
      "A version not greater than the head, and reusing a consumed upload, are refused with 422.",
    ],
    details: {
      v1,
      v2: { id: v2.id, parent: v2.parent_version_id },
      stale: stale.result.body,
      notGreater: notGreater.result.body,
      reuse: reuse.result.body,
      headVersionId: appRow?.head_version_id,
      upload,
      versionRows: staleRows,
    },
  });
});

test("upload limits and object checks", async ({ cloud }) => {
  const owner = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  archives.add(app.id);
  await grantSubscription(app.id, "team");

  const tooLarge = await call<ErrorBody>("archive-upload-url", owner, {
    appId: app.id,
    kind: "version",
    size: 524_288_001,
    sha256: "a".repeat(64),
  });
  const missing = await call<{ uploadId: string }>("archive-upload-url", owner, {
    appId: app.id,
    kind: "version",
    size: 10,
    sha256: "b".repeat(64),
  });
  const notUploaded = await publish(owner, app.id, {
    version: "1.0.0",
    expectedHeadVersionId: null,
    uploadId: missing.body.uploadId,
  });
  const lying = await uploadArchive(owner, app.id, { bytes: fakeArchive(100), declaredSize: 4096 });
  const mismatch = await publish(owner, app.id, {
    version: "1.0.0",
    expectedHeadVersionId: null,
    uploadId: lying.uploadId,
  });
  const ok = await uploadArchive(owner, app.id);
  const overwriteAttempt = await fetch(ok.signedUrl, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(fakeArchive()),
  });
  const { data: failed } = await getServiceClient()
    .from("archive_uploads")
    .select("status")
    .eq("id", lying.uploadId)
    .single();

  expect(tooLarge.status).toBe(413);
  expect(tooLarge.body.error.code).toBe("TOO_LARGE");
  expect(notUploaded.result.status).toBe(422);
  expect(notUploaded.result.body.error.message).toMatch(/not uploaded/);
  expect(mismatch.result.status).toBe(422);
  expect(mismatch.result.body.error.details).toMatchObject({ expectedSize: 4096, actualSize: 100 });
  expect(failed?.status).toBe("failed");
  expect(ok.putStatus).toBe(200);
  expect(overwriteAttempt.status).not.toBe(200);

  recordOutcome("publish-02-upload-checks", {
    expectations: [
      "archive-upload-url refuses a declared size over 500 MB with 413 TOO_LARGE.",
      "Publishing an upload whose object was never stored, or whose stored size differs from the declared size, is refused with 422 (the mismatched upload is marked failed).",
      "A signed upload URL accepts one PUT; a second PUT to the same URL is rejected.",
    ],
    details: {
      tooLarge: tooLarge.body,
      notUploaded: notUploaded.result.body,
      mismatch: mismatch.result.body,
      failedStatus: failed?.status,
      secondPutStatus: overwriteAttempt.status,
    },
  });
});

test("security summary, owner-only and entitlement gates", async ({ cloud }) => {
  const owner = await cloud.user();
  const member = await cloud.user();
  const pgApp = await cloud.app(await cloud.org(owner), owner, { datasourceKind: "postgres" });
  archives.add(pgApp.id);
  const role = await createRole(pgApp.id);
  await addMember(pgApp.id, member.user.id, role.id);

  const unentitled = await call<ErrorBody>("archive-upload-url", owner, {
    appId: pgApp.id,
    kind: "version",
    size: 10,
    sha256: "d".repeat(64),
  });
  await grantSubscription(pgApp.id, "team");
  const pgSecurity = {
    store: "postgres",
    tls: false,
    credentialMode: "shared",
    concurrencyPoliciesResolved: true,
  };
  const upload = await uploadArchive(owner, pgApp.id);
  const attempt = (security: Record<string, unknown>) =>
    publish(owner, pgApp.id, {
      version: "1.0.0",
      expectedHeadVersionId: null,
      uploadId: upload.uploadId,
      security,
    });
  const noTls = await attempt(pgSecurity);
  const noShared = await attempt({ ...pgSecurity, insecureTransportConfirmed: true });
  const unresolved = await attempt({
    ...pgSecurity,
    insecureTransportConfirmed: true,
    sharedCredentialAcknowledged: true,
    concurrencyPoliciesResolved: false,
  });
  const byMember = await call<ErrorBody>("archive-upload-url", member, {
    appId: pgApp.id,
    kind: "version",
    size: 10,
    sha256: "c".repeat(64),
  });
  const ok = await attempt({
    ...pgSecurity,
    insecureTransportConfirmed: true,
    sharedCredentialAcknowledged: true,
  });

  expect(unentitled.status).toBe(402);
  expect(unentitled.body.error.code).toBe("ENTITLEMENT_REQUIRED");
  expect(noTls.result.status).toBe(422);
  expect(noTls.result.body.error.message).toMatch(/insecureTransportConfirmed/);
  expect(noShared.result.body.error.message).toMatch(/sharedCredentialAcknowledged/);
  expect(unresolved.result.body.error.message).toMatch(/concurrencyPoliciesResolved/);
  expect(byMember.status).toBe(403);
  expect(ok.result.status).toBe(200);
  expect(ok.result.body.version.security).toMatchObject({
    store: "postgres",
    tls: false,
    credentialMode: "shared",
    insecureTransportConfirmed: true,
    sharedCredentialAcknowledged: true,
    concurrencyPoliciesResolved: true,
  });
  expect(SQLITE_SECURITY.tls).toBe(true);

  recordOutcome("publish-03-security-summary", {
    expectations: [
      "Without a subscription the owner cannot even request a version upload (402 ENTITLEMENT_REQUIRED), and a Runtime User cannot request a version upload (403).",
      "A non-TLS PostgreSQL publish needs insecureTransportConfirmed, a shared credential needs sharedCredentialAcknowledged, and unresolved concurrency policies are refused, each with 422 naming the field.",
      "With every warning confirmed the version stores the normalized security summary (store postgres, tls false, shared, both confirmations).",
    ],
    details: {
      unentitled: unentitled.body,
      noTls: noTls.result.body,
      noShared: noShared.result.body,
      unresolved: unresolved.result.body,
      byMember: byMember.body,
      security: ok.result.body.version?.security,
    },
  });
});
