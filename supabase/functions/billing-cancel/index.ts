// billing-cancel {appId, atPeriodEnd?=true} → {subscription}
// Cancels the app's subscription with the provider: at the end of the paid
// period by default, or at once with atPeriodEnd:false. The local row is
// updated right away; the provider's webhook confirms it. With the fake
// provider the confirming event is posted (signed) by this function.
import { audit } from "../_shared/audit.ts";
import { billingProvider, buildFakeEvent, ENDED_STATUSES } from "../_shared/billing.ts";
import {
  getSubscription,
  postSignedEvent,
  publicSubscription,
  requireBillingApp,
} from "../_shared/commercial.ts";
import { serviceClient } from "../_shared/db.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { bool, uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const atPeriodEnd = bool(body, "atPeriodEnd", { optional: true }) ?? true;
    await enforceNamedRateLimit("billing-cancel", user.id);
    const app = await requireBillingApp(appId, user.id);
    const subscription = await getSubscription(appId);
    if (!subscription || ENDED_STATUSES.includes(subscription.status)) {
      throw new HttpError("VALIDATION", "appId: the app has no active subscription", {
        field: "appId",
      });
    }

    const provider = billingProvider();
    if (subscription.stripe_subscription_id) {
      await provider.cancelSubscription({
        subscriptionId: subscription.stripe_subscription_id,
        atPeriodEnd,
      });
    }
    // The fake provider confirms through the signed webhook first, like Stripe.
    if (provider.name === "fake" && subscription.stripe_subscription_id) {
      await postSignedEvent(
        buildFakeEvent({
          type: atPeriodEnd ? "customer.subscription.updated" : "customer.subscription.deleted",
          appId,
          planId: subscription.plan_id,
          customerId: subscription.stripe_customer_id ?? undefined,
          subscriptionId: subscription.stripe_subscription_id,
          status: atPeriodEnd ? subscription.status : "canceled",
          cancelAtPeriodEnd: atPeriodEnd,
          currentPeriodEnd: subscription.current_period_end
            ? Math.floor(Date.parse(subscription.current_period_end) / 1000)
            : undefined,
        }),
      );
    }
    // Optimistic local update; the provider webhook confirms it (idempotent).
    const patch = atPeriodEnd
      ? { cancel_at_period_end: true }
      : { status: "canceled", cancel_at_period_end: false };
    const { error } = await serviceClient().from("subscriptions").update(patch).eq("app_id", appId);
    if (error) throw new Error(`update subscription failed: ${error.message}`);

    await audit({
      action: atPeriodEnd ? "billing.cancel_requested" : "billing.subscription_canceled",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `plan:${subscription.plan_id}`,
      details: { atPeriodEnd, planId: subscription.plan_id, previousStatus: subscription.status },
      req,
    });
    await incrementMetric("billing.cancel");
    return { subscription: publicSubscription(await getSubscription(appId)) };
  }),
);
