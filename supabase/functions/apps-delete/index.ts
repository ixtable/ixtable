// Soft-deletes a cloud app after typed-name confirmation. The app owner or an
// organization owner may delete. Every Runtime User is revoked, every
// installation and live key grant is revoked, and pending invitations are
// cancelled, so no further bundle, sync, key grant or backup succeeds.
// Billing mirrors account-delete: while the app has a subscription that
// still bills, the call is refused with 403 FORBIDDEN details
// {reason:"active_subscription", subscriptionStatus} unless
// cancelSubscription:true, which cancels it with the provider at once
// (audited billing.subscription_canceled) before the app is deleted.
//
// POST {appId, confirm:<app name>, cancelSubscription?}
//   → {appId, deletedAt, subscriptionStatus, subscriptionCanceled}
import { audit } from "../_shared/audit.ts";
import { serviceClient } from "../_shared/db.ts";
import { cancelSubscriptionNow, isBilling } from "../_shared/commercial.ts";
import { loadApp, orgRole } from "../_shared/distribution.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { bool, str, uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const confirm = str(body, "confirm", { max: 200 });
    const cancelSubscription = bool(body, "cancelSubscription", { optional: true }) ?? false;

    await enforceNamedRateLimit("apps-delete", user.id);
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
    const { data: subscription, error: subError } = await db
      .from("subscriptions")
      .select("app_id, status, plan_id, stripe_subscription_id")
      .eq("app_id", appId)
      .maybeSingle();
    if (subError) throw new Error(`load subscription: ${subError.message}`);
    const billing = isBilling(subscription?.status as string | undefined);
    if (billing && !cancelSubscription)
      throw new HttpError(
        "FORBIDDEN",
        "This app has an active subscription. Cancel it first, or confirm cancelSubscription.",
        { reason: "active_subscription", subscriptionStatus: subscription!.status },
      );
    // Cancel billing first: if the provider refuses, nothing was deleted.
    if (billing)
      await cancelSubscriptionNow(subscription!, {
        actorId: user.id,
        orgId: app.org_id,
        reason: "app_delete",
        req,
      });

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
        subscriptionCanceled: billing,
      },
      req,
    });
    await incrementMetric("apps.delete");
    return {
      appId,
      deletedAt: now,
      subscriptionStatus: billing ? "canceled" : subscriptionStatus,
      subscriptionCanceled: billing,
    };
  }),
);
