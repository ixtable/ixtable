// billing-portal {appId} → {url}
// Provider billing portal (payment method, invoices, plan changes) for an
// app that has a billing customer. Owner and org owner/admin/billing only.
import { billingProvider } from "../_shared/billing.ts";
import { appBillingUrl, getSubscription, requireBillingApp } from "../_shared/commercial.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit } from "../_shared/rateLimit.ts";
import { uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const appId = uuid(await readJson(req), "appId");
    await enforceNamedRateLimit("billing-portal", user.id);
    await requireBillingApp(appId, user.id);
    const subscription = await getSubscription(appId);
    if (!subscription?.stripe_customer_id) {
      throw new HttpError("VALIDATION", "appId: the app has no billing account yet", {
        field: "appId",
      });
    }
    const { url } = await billingProvider().createPortal({
      customerId: subscription.stripe_customer_id,
      appId,
      returnUrl: appBillingUrl(appId),
    });
    return { url };
  }),
);
