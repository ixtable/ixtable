// Accepts an invitation with the raw token from the accept link. The
// signed-in user's verified email must equal the invited email. Single use
// and expiring (7 days). App invitations activate a Runtime User and need an
// entitled app with room in the runtime-user allowance (402
// ENTITLEMENT_REQUIRED otherwise; the invitation stays usable). The check
// and the write run in one transaction (SQL distribution_accept_invitation).
// Audits invitation.accept and member.add (app) or org_member.add (org).
//
// POST {token} → {membership:{kind, invitationId, orgId, appId?, userId, roleId?|role, status?}}
import { audit } from "../_shared/audit.ts";
import { sha256Hex } from "../_shared/crypto.ts";
import { rpc } from "../_shared/distribution.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { str } from "../_shared/validate.ts";

interface Membership {
  kind: "org" | "app";
  invitationId: string;
  orgId: string;
  appId?: string;
  userId: string;
  roleId?: string;
  role?: string;
  status?: string;
}

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const token = str(body, "token", { min: 16, max: 200 });

    await enforceRateLimit(`invitations-accept:${user.id}`, 20, 600);
    if (!user.email || !user.email_confirmed_at)
      throw new HttpError("FORBIDDEN", "Verify your email address before accepting an invitation");

    const membership = await rpc<Membership>("distribution_accept_invitation", {
      p_token_hash: await sha256Hex(token),
      p_user_id: user.id,
      p_email: user.email.toLowerCase(),
    });

    await audit({
      action: "invitation.accept",
      actorId: user.id,
      orgId: membership.orgId,
      appId: membership.appId ?? null,
      target: `invitation:${membership.invitationId}`,
      details: { kind: membership.kind },
      req,
    });
    await audit({
      action: membership.kind === "app" ? "member.add" : "org_member.add",
      actorId: user.id,
      orgId: membership.orgId,
      appId: membership.appId ?? null,
      target: `user:${user.id}`,
      details:
        membership.kind === "app"
          ? { roleId: membership.roleId, via: "invitation" }
          : { role: membership.role, via: "invitation" },
      req,
    });
    await incrementMetric("invitations.accept");
    return { membership };
  }),
);
