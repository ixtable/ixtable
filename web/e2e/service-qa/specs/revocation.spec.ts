/**
 * Contracts: devices-revoke and credential-delete (PRD §21.3, §25).
 * Revocation blocks future key grants; it cannot erase a credential already
 * decrypted on a device.
 */
import { callFunction } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { addMember, createInstallation } from "../seed";
import {
  auditRows,
  credentialWorld,
  grantRows,
  requestGrant,
  sealSecret,
  uploadEnvelope,
} from "./credentials-fixtures";

const SECRET = { user: "app_rw", password: "pg-pass" };

test("the owner revokes a device; its grants stop", async ({ cloud }) => {
  const { owner, member, app, installationId } = await credentialWorld(cloud);
  await uploadEnvelope(owner, app.id, sealSecret(SECRET));
  const before = await requestGrant(member, app.id, installationId);
  expect(before.status).toBe(200);

  const revoke = await callFunction<Record<string, unknown>>("devices-revoke", {
    jwt: owner.jwt,
    body: { appId: app.id, userId: member.user.id, installationId },
  });
  expect(revoke.status).toBe(200);
  expect(revoke.body).toMatchObject({
    installation: { id: installationId },
    revokedGrants: 1,
    alreadyRevoked: false,
  });

  const after = await requestGrant(member, app.id, installationId);
  expect(after.status).toBe(403);
  expect(after.body.error?.code).toBe("REVOKED");

  const { data: installation } = await cloud.admin
    .from("installations")
    .select("revoked_at, revoked_by")
    .eq("id", installationId)
    .single();
  expect(installation?.revoked_by).toBe(owner.user.id);
  const grants = await grantRows(app.id);
  expect(grants).toHaveLength(1);
  expect(grants[0].revoked_at).not.toBeNull();
  const audit = await auditRows(app.id, "credential.revoke");
  expect(audit).toMatchObject([
    {
      actor_id: owner.user.id,
      target: `installation:${installationId}`,
      details: { kind: "installation", self: false },
    },
  ]);

  recordOutcome("revocation-01-owner-revokes-device", {
    expectations: [
      "devices-revoke by the owner returns 200, marks the installation revoked_by the owner and revokes its live grant.",
      "The member's next key-grant from that installation returns 403 REVOKED.",
      "A credential.revoke audit event names the installation.",
    ],
    details: { revoke: revoke.body, after: after.body, audit: audit[0] },
  });
});

test("members revoke only their own devices", async ({ cloud }) => {
  const { member, app, roleId, installationId } = await credentialWorld(cloud);
  const other = await cloud.user();
  await addMember(app.id, other.user.id, roleId);
  const otherInstallation = await createInstallation(app.id, other.user.id);
  const stranger = await cloud.user();

  const forbidden = await callFunction("devices-revoke", {
    jwt: member.jwt,
    body: { appId: app.id, userId: other.user.id, installationId: otherInstallation },
  });
  const hidden = await callFunction("devices-revoke", {
    jwt: stranger.jwt,
    body: { appId: app.id, userId: member.user.id, installationId },
  });
  const self = await callFunction("devices-revoke", {
    jwt: member.jwt,
    body: { appId: app.id, userId: member.user.id, installationId },
  });

  expect([forbidden.status, hidden.status, self.status]).toEqual([403, 404, 200]);
  const { data: rows } = await cloud.admin
    .from("installations")
    .select("id, revoked_at")
    .in("id", [installationId, otherInstallation]);
  const revoked = Object.fromEntries((rows ?? []).map((row) => [row.id, row.revoked_at !== null]));
  expect(revoked).toEqual({ [installationId]: true, [otherInstallation]: false });

  recordOutcome("revocation-02-self-service-only", {
    expectations: [
      "A Runtime User revoking someone else's device gets 403 FORBIDDEN; an unrelated user gets 404 NOT_FOUND.",
      "A Runtime User can revoke their own device (200); only that installation is revoked.",
    ],
    details: { forbidden: forbidden.body, hidden: hidden.body, self: self.body, revoked },
  });
});

test("deleting a credential makes later grants fail with NOT_FOUND", async ({ cloud }) => {
  const { owner, member, app, installationId } = await credentialWorld(cloud);
  const upload = await uploadEnvelope(owner, app.id, sealSecret(SECRET));
  await requestGrant(member, app.id, installationId);

  const byMember = await callFunction("credential-delete", {
    jwt: member.jwt,
    body: { appId: app.id, datasourceId: "main" },
  });
  const deleted = await callFunction<Record<string, unknown>>("credential-delete", {
    jwt: owner.jwt,
    body: { appId: app.id, datasourceId: "main", scope: "shared" },
  });
  const grant = await requestGrant(member, app.id, installationId);

  expect(byMember.status).toBe(403);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toEqual({ revokedEnvelopeIds: [upload.body.envelopeId], revokedGrants: 1 });
  expect(grant.status).toBe(404);
  expect(grant.body.error?.code).toBe("NOT_FOUND");
  const { data: row } = await cloud.admin
    .from("credential_envelopes")
    .select("revoked_at, revoked_by, ciphertext, wrapped_dek")
    .eq("id", upload.body.envelopeId)
    .single();
  expect(row).toMatchObject({ revoked_by: owner.user.id, ciphertext: "", wrapped_dek: "" });
  expect((await auditRows(app.id, "credential.revoke"))[0]?.details).toMatchObject({
    kind: "envelope",
  });

  recordOutcome("revocation-03-credential-delete", {
    expectations: [
      "Only the owner may call credential-delete (a member gets 403 FORBIDDEN).",
      "After deletion the envelope row is revoked with its ciphertext and wrapped DEK erased, and its live grant is revoked.",
      "The next key-grant for that datasource returns 404 NOT_FOUND.",
    ],
    details: { byMember: byMember.body, deleted: deleted.body, grant: grant.body },
  });
});
