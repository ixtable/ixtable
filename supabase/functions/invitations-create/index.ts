// Invites someone by email to an organization or a cloud app (PRD §21.1).
// Only sha256(token) is stored; the raw token travels in the accept link
// `${SITE_URL}/invite?token=…` and nowhere else. Invitations expire after 7
// days and are single use. A newer invitation for the same email and target
// revokes the older pending ones.
//
// Delivery: a new email address gets a Supabase Auth invitation (sign-up
// link that lands on the accept page); an existing account gets a sign-in
// link (magic link) to the accept page. Both arrive in Mailpit locally.
// Delivery failures do not fail the request, and the reply never says which
// kind of email went out: `delivery` is always "sent", so the response does
// not reveal whether the address has an account. `acceptUrl` can be shared
// by other means.
//
// App invitations: app owner or org owner/admin, `roleId` must be an app role.
// Org invitations: org owner/admin, `role` admin|billing|member.
//
// POST {kind:"app", appId, email, roleId} | {kind:"org", orgId, email, role}
//   → {invitation, acceptUrl, delivery:"sent"}
import { audit } from "../_shared/audit.ts";
import { randomToken, sha256Hex } from "../_shared/crypto.ts";
import { anonClient, optionalEnv, serviceClient } from "../_shared/db.ts";
import { isAppAdmin, loadApp, orgRole } from "../_shared/distribution.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { email as readEmail, oneOf, uuid } from "../_shared/validate.ts";

const PUBLIC_COLUMNS =
  "id, kind, org_id, app_id, email, org_role, role_id, invited_by, created_at, expires_at, accepted_at, revoked_at";

function siteUrl(): string {
  return (optionalEnv("SITE_URL") ?? "http://127.0.0.1:3001").replace(/\/$/, "");
}

async function deliver(
  email: string,
  acceptUrl: string,
): Promise<"invite" | "magic_link" | "none"> {
  try {
    const { data: profile } = await serviceClient()
      .from("profiles")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    if (!profile) {
      const { error } = await serviceClient().auth.admin.inviteUserByEmail(email, {
        redirectTo: acceptUrl,
      });
      return error ? "none" : "invite";
    }
    const { error } = await anonClient().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: acceptUrl },
    });
    return error ? "none" : "magic_link";
  } catch {
    return "none";
  }
}

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const kind = oneOf(body, "kind", ["org", "app"] as const);
    const email = readEmail(body, "email");

    await enforceNamedRateLimit("invitations-create", user.id);
    const db = serviceClient();
    let row: Record<string, unknown>;
    let orgId: string;
    let appId: string | null = null;
    if (kind === "app") {
      appId = uuid(body, "appId");
      const roleId = uuid(body, body.roleId === undefined ? "role" : "roleId");
      const app = await loadApp(appId);
      if (!(await isAppAdmin(app, user.id)))
        throw new HttpError(
          "FORBIDDEN",
          "Only the app's Developer or an organization admin can invite",
        );
      const { data: role } = await db
        .from("app_roles")
        .select("id")
        .eq("app_id", appId)
        .eq("id", roleId)
        .maybeSingle();
      if (!role)
        throw new HttpError("VALIDATION", "roleId: is not a role of this app", { field: "roleId" });
      const { data: owner } = await db
        .from("profiles")
        .select("email")
        .eq("id", app.owner_id)
        .maybeSingle();
      if (owner?.email?.toLowerCase() === email)
        throw new HttpError(
          "VALIDATION",
          "email: the app owner cannot be invited as a Runtime User",
          {
            field: "email",
          },
        );
      orgId = app.org_id;
      row = { kind, app_id: appId, role_id: roleId, email };
    } else {
      orgId = uuid(body, "orgId");
      const role = oneOf(body, body.role === undefined ? "orgRole" : "role", [
        "admin",
        "billing",
        "member",
      ] as const);
      const mine = await orgRole(orgId, user.id);
      if (!mine) throw new HttpError("NOT_FOUND", "Organization not found");
      if (mine !== "owner" && mine !== "admin")
        throw new HttpError("FORBIDDEN", "Only organization owners and admins can invite");
      row = { kind, org_id: orgId, org_role: role, email };
    }

    const now = new Date().toISOString();
    let pending = db
      .from("invitations")
      .update({ revoked_at: now })
      .eq("email", email)
      .eq("kind", kind)
      .is("accepted_at", null)
      .is("revoked_at", null);
    pending = kind === "app" ? pending.eq("app_id", appId) : pending.eq("org_id", orgId);
    await pending;

    const token = randomToken(32);
    const { data: invitation, error } = await db
      .from("invitations")
      .insert({ ...row, token_hash: await sha256Hex(token), invited_by: user.id })
      .select(PUBLIC_COLUMNS)
      .single();
    if (error || !invitation) throw new Error(`create invitation: ${error?.message}`);

    const acceptUrl = `${siteUrl()}/invite?token=${encodeURIComponent(token)}`;
    const delivery = await deliver(email, acceptUrl);
    await audit({
      action: "invitation.create",
      actorId: user.id,
      orgId,
      appId,
      target: `invitation:${invitation.id}`,
      details: {
        kind,
        email,
        roleId: row.role_id ?? null,
        orgRole: row.org_role ?? null,
        // Not the delivery kind: audit readers must not learn whether the account exists.
        emailSent: delivery !== "none",
      },
      req,
    });
    await incrementMetric("invitations.create");
    return { invitation, acceptUrl, delivery: "sent" as const };
  }),
);
