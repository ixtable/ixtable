// Billing provider abstraction (PRD §4.2, Phase 5).
//
// BILLING_PROVIDER selects the implementation:
// - "stripe": real Stripe REST API via fetch (STRIPE_SECRET_KEY).
// - "fake": local/QA. Checkout returns a website URL; the flow completes when
//   a Stripe-shaped event signed with STRIPE_WEBHOOK_SECRET is posted to
//   stripe-webhook (see buildFakeEvent + signStripePayload).
// stripe-webhook verifies both the same way (verifyStripeSignature).
import { hmacSha256Hex, randomToken, timingSafeEqual } from "./crypto.ts";

export interface CheckoutInput {
  appId: string;
  planId: string;
  /** plans.stripe_price_id */
  priceId: string;
  userId: string;
  customerEmail: string;
  /** Reuse an existing Stripe customer when the app already has one. */
  customerId?: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: string;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
}

export interface BillingProvider {
  readonly name: "stripe" | "fake";
  createCheckout(input: CheckoutInput): Promise<{ url: string; sessionId: string }>;
  createPortal(input: {
    customerId: string;
    appId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  listInvoices(input: { customerId: string }): Promise<Invoice[]>;
  cancelSubscription(input: { subscriptionId: string; atPeriodEnd: boolean }): Promise<void>;
}

/** The provider named by BILLING_PROVIDER (required; "stripe" or "fake"). */
export function billingProvider(): BillingProvider {
  const name = Deno.env.get("BILLING_PROVIDER");
  if (name === "fake") return fakeProvider(Deno.env.get("SITE_URL") ?? "http://127.0.0.1:3001");
  if (name === "stripe") {
    const key = Deno.env.get("STRIPE_SECRET_KEY");
    if (!key) throw new Error("Missing required environment variable STRIPE_SECRET_KEY");
    return stripeProvider(key);
  }
  throw new Error("BILLING_PROVIDER must be 'stripe' or 'fake'");
}

// Stripe signatures ------------------------------------------------------------

/** Parses `t=<unix>,v1=<hex>[,v1=<hex>]`. */
export function parseStripeSignatureHeader(header: string): {
  timestamp: number;
  signatures: string[];
} {
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((item) => item?.trim());
    if (key === "t") timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  return { timestamp, signatures };
}

/** Builds a `Stripe-Signature` header value for `payload` (used by the fake provider and tests). */
export async function signStripePayload(
  payload: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${payload}`)}`;
}

/**
 * Verifies a Stripe-Signature header against the raw request body with the
 * webhook secret, rejecting timestamps outside `toleranceSeconds`.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  const { timestamp, signatures } = parseStripeSignatureHeader(header);
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

// Fake provider ----------------------------------------------------------------

export interface FakeEventInput {
  type:
    | "checkout.session.completed"
    | "customer.subscription.created"
    | "customer.subscription.updated"
    | "customer.subscription.deleted"
    | "invoice.payment_failed";
  appId: string;
  planId: string;
  status?: string;
  customerId?: string;
  subscriptionId?: string;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  eventId?: string;
}

/**
 * A Stripe-shaped event for the fake provider. Objects carry
 * `metadata.app_id` / `metadata.plan_id`, as real checkouts created by
 * stripeProvider do.
 */
export function buildFakeEvent(input: FakeEventInput): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const metadata = { app_id: input.appId, plan_id: input.planId };
  const customer = input.customerId ?? `cus_fake_${input.appId.slice(0, 8)}`;
  const subscription = input.subscriptionId ?? `sub_fake_${input.appId.slice(0, 8)}`;
  const object =
    input.type === "checkout.session.completed"
      ? {
          object: "checkout.session",
          id: `cs_fake_${randomToken(8)}`,
          mode: "subscription",
          client_reference_id: input.appId,
          customer,
          subscription,
          metadata,
        }
      : input.type === "invoice.payment_failed"
        ? { object: "invoice", id: `in_fake_${randomToken(8)}`, customer, subscription, metadata }
        : {
            object: "subscription",
            id: subscription,
            customer,
            status:
              input.status ??
              (input.type === "customer.subscription.deleted" ? "canceled" : "active"),
            current_period_end: input.currentPeriodEnd ?? now + 30 * 86_400,
            cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
            metadata,
            items: { data: [{ price: { id: `price_fake_${input.planId}` } }] },
          };
  return {
    id: input.eventId ?? `evt_fake_${randomToken(12)}`,
    object: "event",
    type: input.type,
    created: now,
    livemode: false,
    data: { object },
  };
}

export function fakeProvider(siteUrl: string): BillingProvider {
  return {
    name: "fake",
    createCheckout(input) {
      const sessionId = `cs_fake_${randomToken(12)}`;
      const url = new URL("/cloud/billing/fake-checkout", siteUrl);
      url.searchParams.set("session", sessionId);
      url.searchParams.set("app", input.appId);
      url.searchParams.set("plan", input.planId);
      return Promise.resolve({ url: url.toString(), sessionId });
    },
    createPortal(input) {
      const url = new URL("/cloud/billing/fake-portal", siteUrl);
      url.searchParams.set("app", input.appId);
      return Promise.resolve({ url: url.toString() });
    },
    listInvoices(input) {
      return Promise.resolve([
        {
          id: `in_fake_${input.customerId}`,
          number: "FAKE-0001",
          status: "paid",
          amountDue: 0,
          amountPaid: 0,
          currency: "usd",
          created: new Date().toISOString(),
          hostedInvoiceUrl: null,
          pdfUrl: null,
        },
      ]);
    },
    cancelSubscription() {
      return Promise.resolve();
    },
  };
}

// Stripe provider ----------------------------------------------------------------

function form(
  fields: Record<string, string | number | boolean | undefined | null>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) params.append(key, String(value));
  }
  return params;
}

export function stripeProvider(
  secretKey: string,
  apiBase = "https://api.stripe.com",
): BillingProvider {
  async function call<T>(method: string, path: string, body?: URLSearchParams): Promise<T> {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2024-06-20",
      },
      body,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        (data as { error?: { message?: string } }).error?.message ?? response.statusText;
      throw new Error(`Stripe ${method} ${path} failed: ${message}`);
    }
    return data as T;
  }

  return {
    name: "stripe",
    async createCheckout(input) {
      const session = await call<{ id: string; url: string }>(
        "POST",
        "/v1/checkout/sessions",
        form({
          mode: "subscription",
          "line_items[0][price]": input.priceId,
          "line_items[0][quantity]": 1,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          client_reference_id: input.appId,
          customer: input.customerId ?? undefined,
          customer_email: input.customerId ? undefined : input.customerEmail,
          "metadata[app_id]": input.appId,
          "metadata[plan_id]": input.planId,
          "metadata[user_id]": input.userId,
          "subscription_data[metadata][app_id]": input.appId,
          "subscription_data[metadata][plan_id]": input.planId,
        }),
      );
      return { url: session.url, sessionId: session.id };
    },
    async createPortal(input) {
      const session = await call<{ url: string }>(
        "POST",
        "/v1/billing_portal/sessions",
        form({ customer: input.customerId, return_url: input.returnUrl }),
      );
      return { url: session.url };
    },
    async listInvoices(input) {
      const list = await call<{ data: Record<string, unknown>[] }>(
        "GET",
        `/v1/invoices?customer=${encodeURIComponent(input.customerId)}&limit=24`,
      );
      return list.data.map((invoice) => ({
        id: String(invoice.id),
        number: (invoice.number as string | null) ?? null,
        status: (invoice.status as string | null) ?? null,
        amountDue: Number(invoice.amount_due ?? 0),
        amountPaid: Number(invoice.amount_paid ?? 0),
        currency: String(invoice.currency ?? "usd"),
        created: new Date(Number(invoice.created ?? 0) * 1000).toISOString(),
        hostedInvoiceUrl: (invoice.hosted_invoice_url as string | null) ?? null,
        pdfUrl: (invoice.invoice_pdf as string | null) ?? null,
      }));
    },
    async cancelSubscription(input) {
      if (input.atPeriodEnd) {
        await call(
          "POST",
          `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
          form({ cancel_at_period_end: true }),
        );
      } else {
        await call("DELETE", `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`);
      }
    },
  };
}
