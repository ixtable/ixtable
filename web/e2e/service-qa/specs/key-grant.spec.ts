/**
 * Contract: key-grant (PRD §21.3). An active Runtime User with a registered
 * installation of an entitled app receives the DEK for a datasource envelope,
 * valid for 24 hours. Everyone else gets a precise error and no DEK.
 */
import { getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { addMember, createInstallation } from "../seed";
import {
  auditRows,
  credentialWorld,
  grantRows,
  openSecret,
  requestGrant,
  sealSecret,
  uploadEnvelope,
} from "./credentials-fixtures";

const SHARED = { user: "app_shared", password: "shared-pass" };
const PERSONAL = { user: "app_member", password: "member-pass" };
const DAY_MS = 24 * 60 * 60 * 1000;

test("a member decrypts the shared credential with the granted DEK", async ({ cloud }) => {
  const { owner, member, app, installationId } = await credentialWorld(cloud);
  await uploadEnvelope(owner, app.id, sealSecret(SHARED));

  const grant = await requestGrant(member, app.id, installationId);
  expect(grant.status).toBe(200);
  expect(openSecret(grant.body.dek, grant.body.envelope)).toEqual(SHARED);
  expect(grant.body).toMatchObject({ datasourceId: "main", renewed: false });
  expect(grant.body.envelope.scope).toBe("shared");

  recordOutcome("key-grant-01-member-decrypts", {
    expectations: [
      "An active member with an installation gets 200 from key-grant with a DEK and the shared envelope.",
      "XChaCha20-Poly1305 with the returned DEK, nonce and aad decrypts the ciphertext to the owner's secret.",
    ],
    details: {
      status: grant.status,
      grantId: grant.body.grantId,
      envelopeScope: grant.body.envelope.scope,
      decryptedKeys: Object.keys(openSecret(grant.body.dek, grant.body.envelope) as object),
    },
  });
});

test("grants expire after 24 hours and are recorded and audited", async ({ cloud }) => {
  const { owner, member, app, installationId } = await credentialWorld(cloud);
  await uploadEnvelope(owner, app.id, sealSecret(SHARED));

  const first = await requestGrant(member, app.id, installationId);
  const second = await requestGrant(member, app.id, installationId);
  const lifetime = Date.parse(first.body.expiresAt) - Date.parse(first.body.issuedAt);
  expect(lifetime).toBe(DAY_MS);
  expect(second.body.renewed).toBe(true);

  const rows = await grantRows(app.id);
  expect(rows).toMatchObject([
    {
      id: first.body.grantId,
      kind: "issue",
      user_id: member.user.id,
      installation_id: installationId,
      renewed_from: null,
    },
    { id: second.body.grantId, kind: "renew", renewed_from: first.body.grantId },
  ]);
  expect(Date.parse(rows[0].expires_at) - Date.parse(rows[0].issued_at)).toBe(DAY_MS);
  expect(rows[0].used_at).not.toBeNull();
  expect((await auditRows(app.id, "key.issue")).map((row) => row.details.grantId)).toEqual([
    first.body.grantId,
  ]);
  expect((await auditRows(app.id, "key.renew")).map((row) => row.details.grantId)).toEqual([
    second.body.grantId,
  ]);

  recordOutcome("key-grant-02-expiry-and-renewal", {
    expectations: [
      "expiresAt is exactly 24 hours after issuedAt, in the response and in the key_grants row.",
      "The first grant is recorded as kind issue (audit key.issue); a second grant while the first is live is kind renew with renewed_from set (audit key.renew).",
    ],
    details: {
      issuedAt: first.body.issuedAt,
      expiresAt: first.body.expiresAt,
      rows: rows.map((row) => ({ id: row.id, kind: row.kind, renewed_from: row.renewed_from })),
    },
  });
});

test("a per-user envelope is preferred over the shared one", async ({ cloud }) => {
  const { owner, member, app, roleId, installationId } = await credentialWorld(cloud);
  const other = await cloud.user();
  await addMember(app.id, other.user.id, roleId);
  const otherInstallation = await createInstallation(app.id, other.user.id);
  await uploadEnvelope(owner, app.id, sealSecret(SHARED));
  const personal = await uploadEnvelope(owner, app.id, sealSecret(PERSONAL), {
    scope: "user",
    userId: member.user.id,
  });

  const mine = await requestGrant(member, app.id, installationId);
  const theirs = await requestGrant(other, app.id, otherInstallation);
  expect(mine.body.envelope).toMatchObject({ id: personal.body.envelopeId, scope: "user" });
  expect(openSecret(mine.body.dek, mine.body.envelope)).toEqual(PERSONAL);
  expect(openSecret(theirs.body.dek, theirs.body.envelope)).toEqual(SHARED);

  recordOutcome("key-grant-03-per-user-preferred", {
    expectations: [
      "A member with a per-user envelope receives that envelope (scope user) and decrypts their own credential.",
      "Another member of the same app without one still receives the shared credential.",
    ],
    details: { mine: mine.body.envelope.scope, theirs: theirs.body.envelope.scope },
  });
});

test("non-members, revoked members and deleted apps get no DEK", async ({ cloud }) => {
  const { owner, member, app, installationId } = await credentialWorld(cloud);
  const stranger = await cloud.user();
  const strangerInstallation = await createInstallation(app.id, stranger.user.id);
  await uploadEnvelope(owner, app.id, sealSecret(SHARED));
  const admin = getServiceClient();

  const nonMember = await requestGrant(stranger, app.id, strangerInstallation);
  await admin
    .from("app_members")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("app_id", app.id)
    .eq("user_id", member.user.id);
  const revoked = await requestGrant(member, app.id, installationId);
  await admin
    .from("app_members")
    .update({ status: "active", revoked_at: null })
    .eq("app_id", app.id);
  await admin.from("cloud_apps").update({ deleted_at: new Date().toISOString() }).eq("id", app.id);
  const deleted = await requestGrant(member, app.id, installationId);

  expect([nonMember.status, revoked.status, deleted.status]).toEqual([404, 403, 404]);
  expect([nonMember.body.error?.code, revoked.body.error?.code, deleted.body.error?.code]).toEqual([
    "NOT_FOUND",
    "REVOKED",
    "NOT_FOUND",
  ]);
  for (const result of [nonMember, revoked, deleted]) expect(result.body.dek).toBeUndefined();
  expect(await grantRows(app.id)).toHaveLength(0);

  recordOutcome("key-grant-04-unauthorized-callers", {
    expectations: [
      "A user with no membership gets 404 NOT_FOUND; a revoked member gets 403 REVOKED.",
      "A member of a deleted app gets 404 NOT_FOUND.",
      "No response carries a DEK and no key_grants row is written.",
    ],
    details: { nonMember: nonMember.body, revoked: revoked.body, deleted: deleted.body },
  });
});

test("key-grant enforces entitlement and the rate limit", async ({ cloud }) => {
  const { owner, member, app, roleId, installationId } = await credentialWorld(cloud, {
    plan: "starter",
  });
  await uploadEnvelope(owner, app.id, sealSecret(SHARED));
  const admin = getServiceClient();

  // Starter allows 5 Runtime Users; 6 active members exceed it.
  for (let i = 0; i < 5; i++) {
    const extra = await cloud.user();
    await addMember(app.id, extra.user.id, roleId);
  }
  const overAllowance = await requestGrant(member, app.id, installationId);
  await admin.from("app_members").delete().eq("app_id", app.id).neq("user_id", member.user.id);
  await admin.from("subscriptions").update({ status: "canceled" }).eq("app_id", app.id);
  const inactive = await requestGrant(member, app.id, installationId);
  await admin.from("subscriptions").update({ status: "active" }).eq("app_id", app.id);

  await admin
    .from("rate_limits")
    .upsert({
      bucket: `key-grant:${member.user.id}:${app.id}`,
      window_start: new Date().toISOString(),
      count: 30,
    });
  const limited = await requestGrant(member, app.id, installationId);

  expect(overAllowance.status).toBe(402);
  expect(overAllowance.body.error).toMatchObject({
    code: "ENTITLEMENT_REQUIRED",
    details: { reason: "over_allowance" },
  });
  expect(inactive.body.error).toMatchObject({
    code: "ENTITLEMENT_REQUIRED",
    details: { reason: "subscription_inactive" },
  });
  expect(limited.status).toBe(429);
  expect(limited.body.error?.code).toBe("RATE_LIMITED");
  expect(await grantRows(app.id)).toHaveLength(0);
  await admin.from("rate_limits").delete().eq("bucket", `key-grant:${member.user.id}:${app.id}`);

  recordOutcome("key-grant-05-entitlement-and-rate-limit", {
    expectations: [
      "Over the plan's runtime-user allowance, or with a canceled subscription, key-grant returns 402 ENTITLEMENT_REQUIRED with the reason.",
      "After 30 grants in an hour for the same user and app, key-grant returns 429 RATE_LIMITED.",
      "None of these calls writes a key_grants row.",
    ],
    details: {
      overAllowance: overAllowance.body,
      inactive: inactive.body,
      limited: limited.body,
    },
  });
});
