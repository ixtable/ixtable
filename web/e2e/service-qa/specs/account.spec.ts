import { randomBytes } from "node:crypto";
import { callFunction, getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { createVersion, sha256Hex } from "../seed";
import { auditActions, checkoutAndPay, subscriptionRow } from "./billing-fixtures";

const BUCKET = "app-archives";
const SECRET_FIELDS = /"(ciphertext|nonce|aad|wrapped_dek|token_hash|ip_hash|dek)"/;

async function seedSecrets(appId: string, ownerId: string, sentinel: string) {
  const admin = getServiceClient();
  const envelope = await admin.from("credential_envelopes").insert({
    app_id: appId,
    datasource_id: "main",
    scope: "shared",
    ciphertext: `${sentinel}-ciphertext`,
    nonce: `${sentinel}-nonce`,
    aad: `${sentinel}-aad`,
    wrapped_dek: `${sentinel}-wrapped`,
    kek_version: 1,
    created_by: ownerId,
  });
  const role = await admin
    .from("app_roles")
    .insert({ app_id: appId, id: crypto.randomUUID(), name: "Clerk" })
    .select()
    .single();
  const invitation = await admin.from("invitations").insert({
    kind: "app",
    app_id: appId,
    role_id: role.data?.id,
    email: `invitee-${randomBytes(4).toString("hex")}@example.com`,
    token_hash: sha256Hex(sentinel),
    invited_by: ownerId,
  });
  if (envelope.error || role.error || invitation.error)
    throw new Error(
      `seed failed: ${envelope.error?.message ?? role.error?.message ?? invitation.error?.message}`,
    );
  return sha256Hex(sentinel);
}

// Archive objects this file uploads; removed after each test, pass or fail.
const uploaded: string[] = [];
test.afterEach(async () => {
  if (uploaded.length > 0) await getServiceClient().storage.from(BUCKET).remove(uploaded.splice(0));
});

test("account-export returns the caller's apps and archives without any secret", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  const version = await createVersion(app, owner.user.id);
  const bytes = Buffer.from(`ixt archive ${randomBytes(8).toString("hex")}`);
  const path = `apps/${app.id}/versions/${version.id}.ixt`;
  await getServiceClient()
    .storage.from(BUCKET)
    .upload(path, bytes, { contentType: "application/octet-stream" });
  uploaded.push(path);
  const sentinel = `SENTINEL${randomBytes(6).toString("hex")}`;
  const tokenHash = await seedSecrets(app.id, owner.user.id, sentinel);

  const result = await callFunction<{
    export: {
      format: string;
      apps: { id: string; versions: { id: string }[]; credentialEnvelopes: unknown[] }[];
      archives: { id: string; urlIndex: number }[];
    };
    archives: string[];
  }>("account-export", { jwt: owner.jwt, body: {} });
  const text = JSON.stringify(result.body);
  const downloaded = Buffer.from(await (await fetch(result.body.archives[0])).arrayBuffer());
  const audited = await auditActions({ actorId: owner.user.id });

  expect(result.status).toBe(200);
  expect(result.body.export.apps).toEqual([
    expect.objectContaining({
      id: app.id,
      versions: [expect.objectContaining({ id: version.id })],
      credentialEnvelopes: [expect.any(Object)],
    }),
  ]);
  expect(result.body.archives).toHaveLength(1);
  expect(downloaded.equals(bytes)).toBe(true);
  expect(text).not.toContain(sentinel);
  expect(text).not.toContain(tokenHash);
  expect(text).not.toMatch(SECRET_FIELDS);
  expect(audited.map((event) => event.action)).toContain("account.export");
  recordOutcome("account-01-export", {
    expectations: [
      "account-export returns the owned app with its version and credential envelope metadata, plus one signed archive URL that downloads the exact bytes.",
      "The export contains no ciphertext, nonce, aad, wrapped DEK, token hash or IP hash (sentinel values and field names absent).",
      "account.export is audited with the caller as actor.",
    ],
    details: {
      format: result.body.export.format,
      apps: result.body.export.apps.map((entry) => ({
        id: entry.id,
        versions: entry.versions.length,
      })),
      archiveIndex: result.body.export.archives,
      archiveUrls: result.body.archives.length,
      bytesMatch: downloaded.equals(bytes),
    },
  });
});

test("account-delete refuses while an owned app has an active subscription", async ({ cloud }) => {
  const owner = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  await checkoutAndPay(owner, app.id, "team");

  const wrongEmail = await callFunction("account-delete", {
    jwt: owner.jwt,
    body: { confirmEmail: "someone@example.com" },
  });
  const refused = await callFunction<{
    error: { code: string; details: { reason: string; appIds: string[] } };
  }>("account-delete", {
    jwt: owner.jwt,
    body: { confirmEmail: owner.email },
  });
  const { data: still } = await getServiceClient().auth.admin.getUserById(owner.user.id);
  const row = await subscriptionRow(app.id);

  expect(wrongEmail.status).toBe(422);
  expect(refused.status).toBe(403);
  expect(refused.body.error).toMatchObject({
    code: "FORBIDDEN",
    details: { reason: "active_subscriptions", appIds: [app.id] },
  });
  expect(still.user?.id).toBe(owner.user.id);
  expect(row?.status).toBe("active");

  recordOutcome("account-02-delete-refused-active-subscription", {
    expectations: [
      "account-delete with the wrong confirmEmail returns 422 VALIDATION.",
      "With an active subscription and no cancelSubscriptions it returns 403 FORBIDDEN, details.reason active_subscriptions naming the app.",
      "Nothing changes: the auth user exists and the subscription is still active.",
    ],
    details: { wrongEmail: wrongEmail.status, refused: refused.body, subscription: row?.status },
  });
});

test("account-delete with cancelSubscriptions cancels billing and removes the account, apps and archives", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const org = await cloud.org(owner);
  const app = await cloud.app(org, owner);
  await checkoutAndPay(owner, app.id, "team");
  const version = await createVersion(app, owner.user.id);
  const path = `apps/${app.id}/versions/${version.id}.ixt`;
  const admin = getServiceClient();
  await admin.storage
    .from(BUCKET)
    .upload(path, Buffer.from("archive"), { contentType: "application/octet-stream" });
  uploaded.push(path);

  const result = await callFunction("account-delete", {
    jwt: owner.jwt,
    body: { confirmEmail: owner.email.toUpperCase(), cancelSubscriptions: true },
  });
  const { data: user } = await admin.auth.admin.getUserById(owner.user.id);
  const { data: appRow } = await admin
    .from("cloud_apps")
    .select("id")
    .eq("id", app.id)
    .maybeSingle();
  const { data: orgRow } = await admin
    .from("organizations")
    .select("id")
    .eq("id", org.id)
    .maybeSingle();
  const { data: objects } = await admin.storage.from(BUCKET).list(`apps/${app.id}/versions`);
  const audit = (await auditActions({ actorId: owner.user.id })).map((event) => event.action);

  expect(result).toMatchObject({ status: 200, body: {} });
  expect(user?.user ?? null).toBeNull();
  expect([appRow, orgRow]).toEqual([null, null]);
  expect(objects ?? []).toEqual([]);
  expect(audit).toEqual(
    expect.arrayContaining(["billing.subscription_canceled", "app.delete", "account.delete"]),
  );

  recordOutcome("account-03-delete-with-cancel", {
    expectations: [
      "account-delete {cancelSubscriptions:true} returns 200 and the auth user no longer exists.",
      "The owned app, its now-empty organization and its archive objects are gone.",
      "billing.subscription_canceled, app.delete and account.delete stay in the audit trail with the deleted user's id as actor.",
    ],
    details: {
      status: result.status,
      userExists: Boolean(user?.user),
      appRow,
      orgRow,
      objects,
      audit,
    },
  });
});

test("account-delete refuses the sole owner of an organization with other members", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const colleague = await cloud.user();
  const org = await cloud.org(owner);
  await getServiceClient()
    .from("org_members")
    .insert({ org_id: org.id, user_id: colleague.user.id, role: "admin" });

  const refused = await callFunction<{
    error: { code: string; details: { reason: string; orgIds: string[] } };
  }>("account-delete", {
    jwt: owner.jwt,
    body: { confirmEmail: owner.email },
  });

  expect(refused.status).toBe(403);
  expect(refused.body.error).toMatchObject({
    code: "FORBIDDEN",
    details: { reason: "sole_org_owner", orgIds: [org.id] },
  });

  recordOutcome("account-04-delete-refused-sole-owner", {
    expectations: [
      "The only owner of an organization that has another member gets 403 FORBIDDEN with details.reason sole_org_owner naming the org.",
    ],
    details: { refused: refused.body },
  });
});
