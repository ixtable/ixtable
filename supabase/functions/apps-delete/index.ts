// Soft-deletes a cloud app after typed-name confirmation. The app owner or an
// organization owner may delete. Every Runtime User is revoked, every
// installation and live key grant is revoked, and pending invitations are
// cancelled, so no further bundle, sync, key grant or backup succeeds.
// Billing is not cancelled here (billing functions own subscriptions); the
// audit event records whether a subscription is still active.
//
// POST {appId, confirm:<app name>} → {appId, deletedAt, subscriptionStatus}
import { audit } from "../_shared/audit.ts";
import { serviceClient } from "../_shared/db.ts";
import { loadApp, orgRole } from "../_shared/distribution.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { str, uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const confirm = str(body, "confirm", { max: 200 });

    await enforceRateLimit(`apps-delete:${user.id}`, 10, 3600);
    const app = await loadApp(appId);
    if (app.owner_id !== user.id && (await orgRole(app.org_id, user.id)) !== "owner")
      throw new HttpError(
        "FORBIDDEN",
        "Only the app's Developer/Owner or an organization owner can delete it",
      );
    if (confirm.trim() !== app.name.trim())
      throw new HttpError("VALIDATION", "confirm: type the app name exactly to delete it", {
        field: "confirm",
      });

    const db = serviceClient();
    const now = new Date().toISOString();
    const deleted = await db
      .from("cloud_apps")
      .update({ deleted_at: now })
      .eq("id", appId)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (deleted.error) throw new Error(`delete app: ${deleted.error.message}`);
    if (!deleted.data) throw new HttpError("NOT_FOUND", "App not found");

    const members = await db
      .from("app_members")
      .update({ status: "revoked", revoked_at: now })
      .eq("app_id", appId)
      .eq("status", "active")
      .select("user_id");
    const installations = await db
      .from("installations")
      .update({ revoked_at: now, revoked_by: user.id })
      .eq("app_id", appId)
      .is("revoked_at", null)
      .select("id");
    await db
      .from("key_grants")
      .update({ revoked_at: now })
      .eq("app_id", appId)
      .is("revoked_at", null);
    await db
      .from("invitations")
      .update({ revoked_at: now })
      .eq("app_id", appId)
      .is("accepted_at", null)
      .is("revoked_at", null);
    const { data: subscription } = await db
      .from("subscriptions")
      .select("status, cancel_at_period_end")
      .eq("app_id", appId)
      .maybeSingle();
    const subscriptionStatus = (subscription?.status as string | undefined) ?? null;

    await audit({
      action: "app.delete",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `app:${appId}`,
      details: {
        name: app.name,
        revokedMembers: (members.data ?? []).length,
        revokedInstallations: (installations.data ?? []).length,
        subscriptionStatus,
        billingCancellationRequired:
          subscriptionStatus !== null &&
          ["active", "trialing", "past_due"].includes(subscriptionStatus) &&
          !subscription?.cancel_at_period_end,
      },
      req,
    });
    await incrementMetric("apps.delete");
    return { appId, deletedAt: now, subscriptionStatus };
  }),
);
