// Plan entitlement checks (PRD §4.2). The rules live in the SQL function
// `app_entitlement(app_id)`; this module calls it with the service role.
import { serviceClient } from "./db.ts";
import { HttpError } from "./http.ts";

export type EntitlementReason =
  | "ok"
  | "grace"
  | "not_found"
  | "app_deleted"
  | "no_subscription"
  | "subscription_inactive"
  | "over_allowance";

export interface Entitlement {
  allowed: boolean;
  reason: EntitlementReason;
  /** Runtime-user allowance of the plan (0 without a subscription). */
  allowance: number;
  /** Active Runtime Users (the owner is not counted). */
  used: number;
  status?: string;
  planId?: string;
}

export async function getEntitlement(appId: string): Promise<Entitlement> {
  const { data, error } = await serviceClient().rpc("app_entitlement", { p_app_id: appId });
  if (error) throw new Error(`app_entitlement failed: ${error.message}`);
  return data as Entitlement;
}

/**
 * Throws 402 ENTITLEMENT_REQUIRED unless the app is entitled. Pass
 * `{ adding: 1 }` when the operation activates a Runtime User, so the
 * allowance must have room for one more.
 */
export async function requireEntitlement(
  appId: string,
  options: { adding?: number } = {},
): Promise<Entitlement> {
  const entitlement = await getEntitlement(appId);
  const adding = options.adding ?? 0;
  if (entitlement.reason === "not_found") throw new HttpError("NOT_FOUND", "App not found");
  if (!entitlement.allowed || entitlement.used + adding > entitlement.allowance) {
    const reason = entitlement.allowed ? "over_allowance" : entitlement.reason;
    throw new HttpError("ENTITLEMENT_REQUIRED", entitlementMessage(reason), {
      reason,
      allowance: entitlement.allowance,
      used: entitlement.used,
    });
  }
  return entitlement;
}

export function entitlementMessage(reason: EntitlementReason): string {
  switch (reason) {
    case "no_subscription":
      return "This app needs an active ixtable Cloud plan.";
    case "subscription_inactive":
      return "The app's subscription is not active.";
    case "over_allowance":
      return "The plan's runtime-user allowance is used up.";
    case "app_deleted":
      return "This app has been deleted.";
    default:
      return "This app is not entitled to this operation.";
  }
}
