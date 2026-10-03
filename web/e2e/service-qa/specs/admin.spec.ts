import { randomBytes } from "node:crypto";
import { callFunction, getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { addMember, createInstallation, createRole, grantSubscription, sha256Hex } from "../seed";
import { auditActions } from "./billing-fixtures";

// A secret-looking key may appear only with the value "[redacted]".
const SECRET_FIELDS =
  /"(ciphertext|nonce|aad|wrapped_?dek|dek|token_?hash|ip_?hash|stripe_customer_id|stripe_subscription_id|refresh_token|access_token)":(?!"\[redacted\]")/i;

type Json = Record<string, unknown>;
interface UserDiagnostics {
  user: Json;
  appMemberships: Json[];
  installations: Json[];
  events: { lastKeyIssue: Json | null };
  apps: Json[];
}

test("admin-support refuses callers who are not operators", async ({ cloud }) => {
  const user = await cloud.user();
  const result = await callFunction("admin-support", {
    jwt: user.jwt,
    body: { query: { email: user.email } },
  });

  expect(result.status).toBe(403);
  expect(result.body).toEqual({ error: { code: "FORBIDDEN", message: expect.any(String) } });

  recordOutcome("admin-01-non-operator-denied", {
    expectations: [
      "A signed-in user without profiles.is_operator gets 403 FORBIDDEN from admin-support.",
    ],
    details: { status: result.status, body: result.body },
  });
});

test("admin-support diagnoses a Runtime User and an app without exposing secrets", async ({
  cloud,
}) => {
  const operator = await cloud.user();
  const owner = await cloud.user();
  const member = await cloud.user();
  const admin = getServiceClient();
  await admin.from("profiles").update({ is_operator: true }).eq("id", operator.user.id);
  const app = await cloud.app(await cloud.org(owner), owner);
  await grantSubscription(app.id, "starter");
  const role = await createRole(app.id, { name: "Clerk" });
  await addMember(app.id, member.user.id, role.id);
  const installationId = await createInstallation(app.id, member.user.id, "QA laptop");
  await admin
    .from("installations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", installationId);
  const sentinel = `SENTINEL${randomBytes(6).toString("hex")}`;
  await admin.from("credential_envelopes").insert({
    app_id: app.id,
    datasource_id: "main",
    scope: "shared",
    ciphertext: sentinel,
    nonce: sentinel,
    aad: sentinel,
    wrapped_dek: sentinel,
    kek_version: 1,
  });
  await admin.from("invitations").insert({
    kind: "app",
    app_id: app.id,
    role_id: role.id,
    email: member.email,
    token_hash: sha256Hex(sentinel),
  });
  await admin.rpc("audit", {
    p_action: "key.issue",
    p_actor_id: member.user.id,
    p_app_id: app.id,
    p_target: `installation:${installationId}`,
    p_details: { datasourceId: "main", dek: sentinel },
  });

  const byEmail = await callFunction<{ diagnostics: UserDiagnostics }>("admin-support", {
    jwt: operator.jwt,
    body: { query: { email: member.email } },
  });
  const byApp = await callFunction<{ diagnostics: { members: Json[] } }>("admin-support", {
    jwt: operator.jwt,
    body: { query: { appId: app.id } },
  });
  const text = JSON.stringify([byEmail.body, byApp.body]);
  const lookups = (await auditActions({ actorId: operator.user.id })).filter(
    (event) => event.action === "admin.lookup",
  );
  const user = byEmail.body.diagnostics;

  expect([byEmail.status, byApp.status]).toEqual([200, 200]);
  expect(user.user).toMatchObject({ exists: true, id: member.user.id, confirmed: true });
  expect(user.appMemberships).toEqual([
    expect.objectContaining({ appId: app.id, roleName: "Clerk", status: "active" }),
  ]);
  expect(user.installations).toEqual([
    expect.objectContaining({ id: installationId, revoked: true, deviceName: "QA laptop" }),
  ]);
  expect(user.events.lastKeyIssue).toMatchObject({
    action: "key.issue",
    details: { datasourceId: "main", dek: "[redacted]" },
  });
  expect(user.apps[0]).toMatchObject({
    entitlement: { allowed: true, reason: "ok", used: 1, allowance: 5 },
    subscription: { planId: "starter", status: "active" },
    credentialStatus: [expect.objectContaining({ datasourceId: "main", revoked: false })],
  });
  expect(byApp.body.diagnostics.members).toEqual([
    expect.objectContaining({ userId: member.user.id, email: member.email }),
  ]);
  expect(text).not.toContain(sentinel);
  expect(text).not.toContain(sha256Hex(sentinel));
  expect(text).not.toMatch(SECRET_FIELDS);
  expect(lookups).toHaveLength(2);

  recordOutcome("admin-02-operator-diagnostics", {
    expectations: [
      "An operator's lookup by email shows the user (confirmed), the app membership with role name, the revoked installation, the last key.issue event and the app's entitlement and subscription.",
      "The lookup by appId lists members by email; neither response contains envelope ciphertext, nonces, wrapped DEKs, token hashes, provider ids or a raw DEK (redacted).",
      "Each lookup is audited as admin.lookup with the operator as actor.",
    ],
    details: {
      byEmail: byEmail.body.diagnostics,
      byAppMembers: byApp.body.diagnostics.members,
      lookups,
    },
  });
});

test("admin-support validates the query and reports unknown users", async ({ cloud }) => {
  const operator = await cloud.user();
  await getServiceClient()
    .from("profiles")
    .update({ is_operator: true })
    .eq("id", operator.user.id);

  const both = await callFunction("admin-support", {
    jwt: operator.jwt,
    body: { query: { email: operator.email, appId: crypto.randomUUID() } },
  });
  const unknown = await callFunction<{ diagnostics: Record<string, unknown> }>("admin-support", {
    jwt: operator.jwt,
    body: { query: { email: `nobody-${randomBytes(4).toString("hex")}@example.com` } },
  });

  expect(both.status).toBe(422);
  expect(unknown.status).toBe(200);
  expect(unknown.body.diagnostics.user).toEqual({ exists: false });

  recordOutcome("admin-03-query-validation", {
    expectations: [
      "A query with both email and appId is rejected with 422 VALIDATION.",
      "An unknown email returns 200 with user {exists:false}.",
    ],
    details: { both: both.body, unknown: unknown.body },
  });
});
