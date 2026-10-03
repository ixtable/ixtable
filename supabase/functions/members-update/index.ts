// Changes a Runtime User's role or status (PRD §20.1, §21.3). The app owner
// or an org owner/admin may call it. Revoking blocks future bundles, key
// grants and backups; re-activating counts against the plan's runtime-user
// allowance (402 ENTITLEMENT_REQUIRED). Ownership transfer is apps-transfer.
// Audits member.role_change, member.revoke and member.activate.
//
// POST {appId, userId, roleId?, status?:"active"|"revoked"} → {member}
import { audit } from "../_shared/audit.ts";
import { serviceClient } from "../_shared/db.ts";
import { loadApp, type MemberRow, requireAppAdmin, rpc } from "../_shared/distribution.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { oneOf, uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const userId = uuid(body, "userId");
    const roleId = uuid(body, "roleId", { optional: true });
    const status = oneOf(body, "status", ["active", "revoked"] as const, { optional: true });
    if (!roleId && !status)
      throw new HttpError("VALIDATION", "roleId or status: one is required", { field: "status" });

    await enforceRateLimit(`members-update:${user.id}`, 120, 3600);
    const app = await loadApp(appId);
    await requireAppAdmin(app, user.id);
    if (userId === app.owner_id)
      throw new HttpError(
        "VALIDATION",
        "userId: the owner is not a Runtime User; use apps-transfer",
        {
          field: "userId",
        },
      );

    const { data: before } = await serviceClient()
      .from("app_members")
      .select("role_id, status")
      .eq("app_id", appId)
      .eq("user_id", userId)
      .maybeSingle();
    const member = await rpc<MemberRow>("distribution_update_member", {
      p_app_id: appId,
      p_user_id: userId,
      p_role_id: roleId ?? null,
      p_status: status ?? null,
    });

    const base = { actorId: user.id, orgId: app.org_id, appId, target: `user:${userId}`, req };
    if (before && before.role_id !== member.role_id)
      await audit({
        ...base,
        action: "member.role_change",
        details: { from: before.role_id, to: member.role_id },
      });
    if (before && before.status !== member.status) {
      await audit({
        ...base,
        action: member.status === "revoked" ? "member.revoke" : "member.activate",
        details: { roleId: member.role_id },
      });
      await incrementMetric(member.status === "revoked" ? "members.revoke" : "members.activate");
    }
    return { member };
  }),
);
