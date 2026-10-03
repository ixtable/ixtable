// Shared helpers for the commercial functions (billing-*, stripe-webhook,
// account-*, admin-support). Authorization rules: billing actions are allowed
// for the app's owner and for org members with role owner, admin or billing.
import { signStripePayload } from "./billing.ts";
import { env, optionalEnv, serviceClient } from "./db.ts";
import { HttpError } from "./http.ts";
import type { SubscriptionState } from "./billing.ts";

export interface BillingApp {
  id: string;
  org_id: string;
  owner_id: string;
  name: string;
  deleted_at: string | null;
}

export interface SubscriptionRow extends SubscriptionState {
  id: string;
  app_id: string;
  provider: "stripe" | "fake";
  created_at: string;
  updated_at: string;
}

export const SUBSCRIPTION_COLUMNS =
  "id, app_id, plan_id, provider, status, current_period_end, cancel_at_period_end, stripe_customer_id, stripe_subscription_id, provider_event_at, created_at, updated_at";

/** Client-facing subscription shape (no provider ids). */
export function publicSubscription(row: SubscriptionRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    app_id: row.app_id,
    plan_id: row.plan_id,
    provider: row.provider,
    status: row.status,
    current_period_end: row.current_period_end,
    cancel_at_period_end: row.cancel_at_period_end,
  };
}

/**
 * Loads a live app the caller may manage billing for. Callers with no
 * relation to the app get NOT_FOUND (existence is not revealed); members
 * without a billing role get FORBIDDEN.
 */
export async function requireBillingApp(appId: string, userId: string): Promise<BillingApp> {
  const db = serviceClient();
  const { data: app, error } = await db
    .from("cloud_apps")
    .select("id, org_id, owner_id, name, deleted_at")
    .eq("id", appId)
    .maybeSingle();
  if (error) throw new Error(`load app failed: ${error.message}`);
  if (!app || app.deleted_at) throw new HttpError("NOT_FOUND", "App not found");
  if (app.owner_id === userId) return app as BillingApp;
  const { data: membership } = await db
    .from("org_members")
    .select("role")
    .eq("org_id", app.org_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (membership && ["owner", "admin", "billing"].includes(membership.role)) {
    return app as BillingApp;
  }
  const { data: appMember } = await db
    .from("app_members")
    .select("status")
    .eq("app_id", appId)
    .eq("user_id", userId)
    .maybeSingle();
  if (membership || appMember) {
    throw new HttpError(
      "FORBIDDEN",
      "Only the app owner or an organization owner, admin or billing member can manage billing",
    );
  }
  throw new HttpError("NOT_FOUND", "App not found");
}

export async function getSubscription(appId: string): Promise<SubscriptionRow | null> {
  const { data, error } = await serviceClient()
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("app_id", appId)
    .maybeSingle();
  if (error) throw new Error(`load subscription failed: ${error.message}`);
  return (data as SubscriptionRow | null) ?? null;
}

export function siteUrl(): string {
  return (optionalEnv("SITE_URL") ?? "http://127.0.0.1:3001").replace(/\/$/, "");
}

/** The website's billing tab of an app (checkout return and portal return URL). */
export function appBillingUrl(appId: string, extra: Record<string, string> = {}): string {
  const url = new URL("/cloud/app", siteUrl());
  url.searchParams.set("id", appId);
  url.searchParams.set("tab", "billing");
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.toString();
}

/**
 * Signs a Stripe-shaped event with STRIPE_WEBHOOK_SECRET and posts it to
 * stripe-webhook, exactly as Stripe would. Used by the fake provider only, so
 * the fake and real flows share one webhook path.
 */
export async function postSignedEvent(event: Record<string, unknown>): Promise<{
  status: number;
  body: unknown;
}> {
  const payload = JSON.stringify(event);
  const signature = await signStripePayload(payload, env("STRIPE_WEBHOOK_SECRET"));
  const response = await fetch(`${env("SUPABASE_URL")}/functions/v1/stripe-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature,
      apikey: env("SUPABASE_ANON_KEY"),
    },
    body: payload,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}
