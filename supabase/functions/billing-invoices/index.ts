// billing-invoices {appId} → {invoices: Invoice[]}
// Invoices from the billing provider for the app's customer (empty before
// the first checkout). Owner and org owner/admin/billing only.
import { billingProvider } from "../_shared/billing.ts";
import { getSubscription, requireBillingApp } from "../_shared/commercial.ts";
import { handler, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit } from "../_shared/rateLimit.ts";
import { uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const appId = uuid(await readJson(req), "appId");
    await enforceNamedRateLimit("billing-invoices", user.id);
    await requireBillingApp(appId, user.id);
    const subscription = await getSubscription(appId);
    if (!subscription?.stripe_customer_id) return { invoices: [] };
    const invoices = await billingProvider().listInvoices({
      customerId: subscription.stripe_customer_id,
    });
    return { invoices };
  }),
);
