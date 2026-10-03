// Transfers an app to a new Developer/Owner (PRD §20.1: exactly one per app).
// Only the current owner may transfer, with typed-name confirmation, to a
// member of the app's organization (not a billing-only member). If the new
// owner was a Runtime User of the app, that membership ends: the owner is
// not a Runtime User. Audits app.transfer.
//
// POST {appId, newOwnerId, confirm:<app name>} → {app}
import { audit } from "../_shared/audit.ts";
import { serviceClient } from "../_shared/db.ts";
import { loadApp, orgRole, requireAppOwner } from "../_shared/distribution.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { str, uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const newOwnerId = uuid(body, "newOwnerId");
    const confirm = str(body, "confirm", { max: 200 });

    await enforceRateLimit(`apps-transfer:${user.id}`, 10, 3600);
    const app = await loadApp(appId);
    requireAppOwner(app, user.id);
    if (confirm.trim() !== app.name.trim())
      throw new HttpError("VALIDATION", "confirm: type the app name exactly to transfer it", {
        field: "confirm",
      });
    if (newOwnerId === user.id)
      throw new HttpError("VALIDATION", "newOwnerId: you already own this app", {
        field: "newOwnerId",
      });
    const role = await orgRole(app.org_id, newOwnerId);
    if (!role || role === "billing")
      throw new HttpError(
        "VALIDATION",
        "newOwnerId: the new owner must be an owner, admin or member of the organization",
        { field: "newOwnerId" },
      );

    const db = serviceClient();
    const { data: updated, error } = await db
      .from("cloud_apps")
      .update({ owner_id: newOwnerId })
      .eq("id", appId)
      .eq("owner_id", user.id)
      .is("deleted_at", null)
      .select()
      .maybeSingle();
    if (error) throw new Error(`transfer app: ${error.message}`);
    if (!updated)
      throw new HttpError("VERSION_CONFLICT", "The app's owner changed; reload and retry");
    await db.from("app_members").delete().eq("app_id", appId).eq("user_id", newOwnerId);

    await audit({
      action: "app.transfer",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `user:${newOwnerId}`,
      details: { fromOwnerId: user.id, toOwnerId: newOwnerId },
      req,
    });
    return { app: updated };
  }),
);
