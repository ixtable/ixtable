/**
 * Contract: credential-envelope (PRD §21.3). The owner uploads a datasource
 * secret encrypted with a DEK; the function wraps the DEK with the KEK and
 * stores only the wrapped form. Envelope secrets are never readable through
 * PostgREST, for any client role.
 */
import { callFunction, getAnonClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { auditRows, credentialWorld, sealSecret, uploadEnvelope } from "./credentials-fixtures";

const SECRET = { user: "app_rw", password: "s3cret-pg-password" };

async function envelopeRows(cloud: { admin: ReturnType<typeof getAnonClient> }, appId: string) {
  const { data, error } = await cloud.admin
    .from("credential_envelopes")
    .select("*")
    .eq("app_id", appId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

test("owner uploads a shared envelope; only the wrapped DEK is stored", async ({ cloud }) => {
  const { owner, app } = await credentialWorld(cloud);
  const sealed = sealSecret(SECRET);

  const result = await uploadEnvelope(owner, app.id, sealed);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    envelopeId: expect.any(String),
    replacedEnvelopeId: null,
    kekVersion: 1,
  });

  const [row] = await envelopeRows(cloud, app.id);
  expect(row).toMatchObject({
    id: result.body.envelopeId,
    scope: "shared",
    user_id: null,
    datasource_id: "main",
    ciphertext: sealed.ciphertext,
    kek_version: 1,
    created_by: owner.user.id,
  });
  expect(row.wrapped_dek).not.toContain(sealed.dek);
  // base64(iv[12] || 32-byte DEK || tag[16]) = 60 bytes = 80 chars.
  expect(Buffer.from(row.wrapped_dek, "base64")).toHaveLength(60);

  const audit = await auditRows(app.id, "credential.upload");
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor_id: owner.user.id, target: "datasource:main" });
  expect(JSON.stringify(audit[0].details)).not.toContain(sealed.dek);

  recordOutcome("credentials-01-owner-upload", {
    expectations: [
      "The app owner's credential-envelope call returns 200 with an envelope id and KEK version 1.",
      "The stored row keeps the ciphertext as sent and a 60-byte AES-GCM wrapped DEK, never the raw DEK.",
      "One credential.upload audit event is written without the DEK in its details.",
    ],
    details: {
      status: result.status,
      envelopeId: result.body.envelopeId,
      auditDetails: audit[0].details,
    },
  });
});

test("only the owner may upload envelopes", async ({ cloud }) => {
  const { member, app } = await credentialWorld(cloud);
  const stranger = await cloud.user();
  const sealed = sealSecret(SECRET);

  const asMember = await uploadEnvelope(member, app.id, sealed);
  const asStranger = await uploadEnvelope(stranger, app.id, sealed);
  const anonymous = await callFunction("credential-envelope", {
    body: { appId: app.id, datasourceId: "main", scope: "shared", ...sealed },
  });

  expect(asMember.status).toBe(403);
  expect(asMember.body).toEqual({ error: { code: "FORBIDDEN", message: expect.any(String) } });
  expect(asStranger.status).toBe(404);
  expect(asStranger.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(anonymous.status).toBe(401);
  expect(await envelopeRows(cloud, app.id)).toHaveLength(0);

  recordOutcome("credentials-02-non-owner-refused", {
    expectations: [
      "A Runtime User of the app gets 403 FORBIDDEN from credential-envelope.",
      "An unrelated signed-in user gets 404 NOT_FOUND and an anonymous caller 401.",
      "No credential_envelopes row is written.",
    ],
    details: {
      member: asMember.body,
      stranger: asStranger.body,
      anonymousStatus: anonymous.status,
    },
  });
});

test("credential-envelope validates the envelope and its target", async ({ cloud }) => {
  const { owner, app } = await credentialWorld(cloud);
  const stranger = await cloud.user();
  const sealed = sealSecret(SECRET);

  const shortNonce = await uploadEnvelope(owner, app.id, {
    ...sealed,
    nonce: Buffer.alloc(12).toString("base64"),
  });
  const shortDek = await uploadEnvelope(owner, app.id, {
    ...sealed,
    dek: Buffer.alloc(16).toString("base64"),
  });
  const notMember = await uploadEnvelope(owner, app.id, sealed, {
    scope: "user",
    userId: stranger.user.id,
  });

  for (const result of [shortNonce, shortDek, notMember]) {
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ error: { code: "VALIDATION" } });
  }
  expect(await envelopeRows(cloud, app.id)).toHaveLength(0);

  recordOutcome("credentials-03-validation", {
    expectations: [
      "A nonce that is not 24 bytes or a DEK that is not 32 bytes is refused with 422 VALIDATION.",
      "A per-user envelope for someone who is not an active member is refused with 422 VALIDATION.",
      "Nothing is stored for refused uploads.",
    ],
    details: {
      twelveByteIv: shortNonce.body,
      sixteenByteKey: shortDek.body,
      notMember: notMember.body,
    },
  });
});

test("a new upload supersedes the old envelope and erases its secrets", async ({ cloud }) => {
  const { owner, app } = await credentialWorld(cloud);

  const first = await uploadEnvelope(owner, app.id, sealSecret(SECRET));
  const second = await uploadEnvelope(
    owner,
    app.id,
    sealSecret({ ...SECRET, password: "rotated" }),
  );
  expect(second.status).toBe(200);
  expect(second.body.replacedEnvelopeId).toBe(first.body.envelopeId);

  const rows = await envelopeRows(cloud, app.id);
  const old = rows.find((row) => row.id === first.body.envelopeId);
  const active = rows.filter((row) => row.superseded_at === null && row.revoked_at === null);
  expect(old).toMatchObject({
    superseded_by: second.body.envelopeId,
    ciphertext: "",
    nonce: "",
    aad: "",
    wrapped_dek: "",
  });
  expect(old?.superseded_at).not.toBeNull();
  expect(active.map((row) => row.id)).toEqual([second.body.envelopeId]);

  recordOutcome("credentials-04-replace-supersedes", {
    expectations: [
      "Uploading again for the same target returns the previous envelope id as replacedEnvelopeId.",
      "The previous row is marked superseded and its ciphertext, nonce, aad and wrapped DEK are erased.",
      "Exactly one active envelope remains for the target.",
    ],
    details: {
      replacedEnvelopeId: second.body.replacedEnvelopeId,
      oldRow: { id: old?.id, superseded_at: old?.superseded_at, superseded_by: old?.superseded_by },
      activeIds: active.map((row) => row.id),
    },
  });
});

test("envelope secrets are unreadable through PostgREST for every client role", async ({
  cloud,
}) => {
  const { owner, member, app } = await credentialWorld(cloud);
  const stranger = await cloud.user();
  await uploadEnvelope(owner, app.id, sealSecret(SECRET));

  const secretColumns = ["ciphertext", "wrapped_dek", "nonce", "aad", "*"];
  // Keyed by role; values follow the column order (keys avoid secret-looking names).
  const denied: Record<string, (string | null)[]> = {};
  for (const [name, client] of [
    ["anon", getAnonClient()],
    ["owner", owner.client],
    ["member", member.client],
    ["stranger", stranger.client],
  ] as const) {
    denied[name] = [];
    for (const column of secretColumns) {
      const { error } = await client
        .from("credential_envelopes")
        .select(column)
        .eq("app_id", app.id);
      denied[name].push(error?.code ?? null);
    }
  }
  for (const codes of Object.values(denied))
    expect(codes).toEqual(secretColumns.map(() => "42501"));

  // Positive control: the owner reads metadata; other users see no rows.
  const metadata = "id, scope, datasource_id, kek_version, superseded_at, revoked_at";
  const ownerMeta = await owner.client
    .from("credential_envelopes")
    .select(metadata)
    .eq("app_id", app.id);
  const memberMeta = await member.client
    .from("credential_envelopes")
    .select(metadata)
    .eq("app_id", app.id);
  expect(ownerMeta.data).toHaveLength(1);
  expect(memberMeta.data).toEqual([]);

  recordOutcome("credentials-05-secrets-unreadable", {
    expectations: [
      "anon, the owner, a member and a stranger all get 42501 selecting ciphertext, wrapped_dek, nonce, aad or *.",
      "The owner can still read envelope metadata (positive control); a member sees no envelope rows.",
    ],
    details: {
      columns: secretColumns,
      denied,
      ownerMetadataRows: ownerMeta.data?.length,
      memberMetadataRows: memberMeta.data,
    },
  });
});
