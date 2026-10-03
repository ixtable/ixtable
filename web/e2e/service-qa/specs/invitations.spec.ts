/**
 * Contract: invitations-create / invitations-accept (PRD §21.1, §4.2).
 * Only sha256(token) is stored; the accept link is `${SITE_URL}/invite?token=`;
 * invitations are single use, expire, and must be accepted by the invited
 * email; accepting an app invitation enforces the plan's runtime-user
 * allowance (402 ENTITLEMENT_REQUIRED leaves the invitation usable).
 */
import { createHash } from "node:crypto";
import { getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { createRole, grantSubscription, uniqueEmail } from "../seed";
import { call, type ErrorBody, ensureSingleUserPlan, subscribe } from "./distribution-fixtures";

type Invite = {
  invitation: { id: string; email: string; expires_at: string };
  acceptUrl: string;
  delivery: string;
};

const tokenOf = (acceptUrl: string) => new URL(acceptUrl).searchParams.get("token") ?? "";

test("invitation stores only the token hash, is single use and bound to the invited email", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const member = await cloud.user();
  const other = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  const role = await createRole(app.id, { name: "Clerk" });
  await grantSubscription(app.id, "starter");

  const created = await call<Invite>("invitations-create", owner, {
    kind: "app",
    appId: app.id,
    email: member.email.toUpperCase(),
    roleId: role.id,
  });
  expect(created.status).toBe(200);
  const url = new URL(created.body.acceptUrl);
  const token = tokenOf(created.body.acceptUrl);
  expect(`${url.origin}${url.pathname}`).toBe("http://127.0.0.1:3001/invite");
  expect(created.body.delivery).toBe("magic_link");
  const { data: row } = await getServiceClient()
    .from("invitations")
    .select("email, token_hash, expires_at, role_id")
    .eq("id", created.body.invitation.id)
    .single();
  expect(row?.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
  expect(JSON.stringify(row)).not.toContain(token);
  expect(row?.email).toBe(member.email.toLowerCase());
  const days = (Date.parse(row?.expires_at) - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.9);
  expect(days).toBeLessThanOrEqual(7);
  // The invitee's client cannot read the token hash column.
  const hashRead = await owner.client
    .from("invitations")
    .select("token_hash")
    .eq("id", created.body.invitation.id);

  const wrongUser = await call<ErrorBody>("invitations-accept", other, { token });
  const accepted = await call<{ membership: Record<string, unknown> }>(
    "invitations-accept",
    member,
    { token },
  );
  const reused = await call<ErrorBody>("invitations-accept", member, { token });
  expect(wrongUser.status).toBe(403);
  expect(accepted.status).toBe(200);
  expect(accepted.body.membership).toMatchObject({
    kind: "app",
    appId: app.id,
    userId: member.user.id,
    roleId: role.id,
    status: "active",
  });
  expect(reused.status).toBe(422);
  expect(hashRead.error).not.toBeNull();
  const { data: memberRow } = await getServiceClient()
    .from("app_members")
    .select("role_id, status, invited_by")
    .eq("app_id", app.id)
    .eq("user_id", member.user.id)
    .single();
  expect(memberRow).toEqual({ role_id: role.id, status: "active", invited_by: owner.user.id });

  recordOutcome("invitations-01-hash-only-single-use", {
    expectations: [
      "invitations-create returns an accept link http://127.0.0.1:3001/invite?token=… and stores only sha256(token), lowercased email and a 7-day expiry; clients cannot select token_hash.",
      "Another signed-in user gets 403 for the token; the invited user gets an active membership with the invited role.",
      "Reusing the token afterwards is refused with 422.",
    ],
    details: {
      delivery: created.body.delivery,
      expiresInDays: days,
      wrongUser: wrongUser.body,
      membership: accepted.body.membership,
      reused: reused.body,
      memberRow,
      clientHashRead: hashRead.error?.message,
    },
  });
});

test("accept enforces entitlement and allowance; expired invitations fail", async ({ cloud }) => {
  const owner = await cloud.user();
  const first = await cloud.user();
  const second = await cloud.user();
  const late = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  const role = await createRole(app.id);
  const invite = async (email: string) =>
    tokenOf(
      (
        await call<Invite>("invitations-create", owner, {
          kind: "app",
          appId: app.id,
          email,
          roleId: role.id,
        })
      ).body.acceptUrl,
    );
  const t1 = await invite(first.email);
  const t2 = await invite(second.email);
  const t3 = await invite(late.email);

  const noPlan = await call<ErrorBody>("invitations-accept", first, { token: t1 });
  await subscribe(app.id, await ensureSingleUserPlan());
  const ok = await call("invitations-accept", first, { token: t1 });
  const over = await call<ErrorBody>("invitations-accept", second, { token: t2 });
  const { data: pending } = await getServiceClient()
    .from("invitations")
    .select("accepted_at")
    .eq("token_hash", createHash("sha256").update(t2).digest("hex"))
    .single();
  await getServiceClient()
    .from("invitations")
    .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq("token_hash", createHash("sha256").update(t3).digest("hex"));
  const expired = await call<ErrorBody>("invitations-accept", late, { token: t3 });

  expect(noPlan.status).toBe(402);
  expect(noPlan.body.error).toMatchObject({
    code: "ENTITLEMENT_REQUIRED",
    details: { reason: "no_subscription" },
  });
  expect(ok.status).toBe(200);
  expect(over.status).toBe(402);
  expect(over.body.error).toMatchObject({
    code: "ENTITLEMENT_REQUIRED",
    details: { reason: "over_allowance" },
  });
  expect(pending?.accepted_at).toBeNull();
  expect(expired.status).toBe(422);
  expect(expired.body.error.message).toMatch(/expired/);
  const { count } = await getServiceClient()
    .from("app_members")
    .select("user_id", { count: "exact", head: true })
    .eq("app_id", app.id);
  expect(count).toBe(1);

  recordOutcome("invitations-02-allowance", {
    expectations: [
      "Accepting without a subscription returns 402 ENTITLEMENT_REQUIRED (no_subscription).",
      "With a one-user plan the first accept succeeds and the second returns 402 over_allowance, leaving that invitation unaccepted and only one member row.",
      "An expired invitation is refused with 422.",
    ],
    details: {
      noPlan: noPlan.body,
      over: over.body,
      secondInvitationAcceptedAt: pending?.accepted_at,
      expired: expired.body,
      members: count,
    },
  });
});

test("org invitation, new-user delivery and permission checks", async ({ cloud }) => {
  const owner = await cloud.user();
  const colleague = await cloud.user();
  const stranger = await cloud.user();
  const org = await cloud.org(owner);
  const app = await cloud.app(org, owner);
  const role = await createRole(app.id);

  const orgInvite = await call<Invite>("invitations-create", owner, {
    kind: "org",
    orgId: org.id,
    email: colleague.email,
    role: "admin",
  });
  const joined = await call<{ membership: Record<string, unknown> }>(
    "invitations-accept",
    colleague,
    {
      token: tokenOf(orgInvite.body.acceptUrl),
    },
  );
  const { data: orgRow } = await getServiceClient()
    .from("org_members")
    .select("role")
    .eq("org_id", org.id)
    .eq("user_id", colleague.user.id)
    .single();
  const strangerInvite = await call<ErrorBody>("invitations-create", stranger, {
    kind: "app",
    appId: app.id,
    email: uniqueEmail(),
    roleId: role.id,
  });
  const badRole = await call<ErrorBody>("invitations-create", owner, {
    kind: "app",
    appId: app.id,
    email: uniqueEmail(),
    roleId: crypto.randomUUID(),
  });
  // A new email address gets a Supabase Auth invitation (creates the auth user).
  const newEmail = uniqueEmail("invitee");
  const fresh = await call<Invite>("invitations-create", owner, {
    kind: "app",
    appId: app.id,
    email: newEmail,
    roleId: role.id,
  });
  const admin = getServiceClient();
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const invitedUser = users.users.find((u) => u.email === newEmail);
  if (invitedUser) await admin.auth.admin.deleteUser(invitedUser.id);

  expect(orgInvite.status).toBe(200);
  expect(joined.body.membership).toMatchObject({ kind: "org", orgId: org.id, role: "admin" });
  expect(orgRow?.role).toBe("admin");
  expect(strangerInvite.status).toBe(403);
  expect(badRole.status).toBe(422);
  expect(fresh.status).toBe(200);
  expect(fresh.body.delivery).toBe("invite");
  expect(invitedUser?.invited_at).toBeTruthy();

  recordOutcome("invitations-03-org-and-delivery", {
    expectations: [
      "An org invitation accepted by the invitee adds them to org_members with the invited role (admin).",
      "A user outside the app cannot invite (403) and an unknown roleId is refused (422).",
      "Inviting an email with no account sends a Supabase Auth invitation (delivery invite, auth user marked invited).",
    ],
    details: {
      joined: joined.body,
      orgRow,
      strangerInvite: strangerInvite.body,
      badRole: badRole.body,
      delivery: fresh.body.delivery,
    },
  });
});
