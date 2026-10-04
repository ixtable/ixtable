// billing-checkout {appId, planId} → {url}
// Starts a provider checkout for an app's plan (PRD §4.2). Allowed for the
// app owner and org owner/admin/billing members. The subscription becomes
// active only through stripe-webhook (real Stripe or the fake provider's
// signed event), never here.
import { audit } from "../_shared/audit.ts";
import { billingProvider } from "../_shared/billing.ts";
import { appBillingUrl, getSubscription, requireBillingApp } from "../_shared/commercial.ts";
import { serviceClient } from "../_shared/db.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { str, uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const planId = str(body, "planId", { min: 1, max: 64 });
    await enforceNamedRateLimit("billing-checkout", user.id);
    const app = await requireBillingApp(appId, user.id);

    const db = serviceClient();
    const { data: plan } = await db
      .from("plans")
      .select("id, stripe_price_id, runtime_user_allowance, active")
      .eq("id", planId)
      .maybeSingle();
    if (!plan || !plan.active)
      throw new HttpError("VALIDATION", "planId: unknown plan", { field: "planId" });
    if (!plan.stripe_price_id)
      throw new HttpError("VALIDATION", "planId: plan is not for sale", { field: "planId" });

    const subscription = await getSubscription(appId);
    if (
      subscription &&
      subscription.plan_id === planId &&
      ["active", "trialing"].includes(subscription.status) &&
      !subscription.cancel_at_period_end
    ) {
      throw new HttpError("VALIDATION", "planId: the app is already on this plan", {
        field: "planId",
      });
    }

    const provider = billingProvider();
    const checkout = await provider.createCheckout({
      appId,
      planId,
      priceId: plan.stripe_price_id,
      userId: user.id,
      customerEmail: user.email ?? "",
      customerId: subscription?.stripe_customer_id ?? null,
      successUrl: appBillingUrl(appId, { checkout: "success" }),
      cancelUrl: appBillingUrl(appId, { checkout: "canceled" }),
    });
    const { error } = await db.from("billing_checkout_sessions").insert({
      id: checkout.sessionId,
      app_id: appId,
      plan_id: planId,
      user_id: user.id,
      provider: provider.name,
    });
    if (error) throw new Error(`record checkout session failed: ${error.message}`);

    const { count: used } = await db
      .from("app_members")
      .select("user_id", { count: "exact", head: true })
      .eq("app_id", appId)
      .eq("status", "active");
    await audit({
      action: "billing.checkout_started",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `plan:${planId}`,
      details: { planId, provider: provider.name, previousPlanId: subscription?.plan_id ?? null },
      req,
    });
    await incrementMetric("billing.checkout");
    // A downgrade below the active Runtime Users is allowed; entitlement then
    // reports over_allowance until members are revoked (PRD §29).
    const overAllowance = (used ?? 0) > plan.runtime_user_allowance;
    return { url: checkout.url, overAllowance };
  }),
);
