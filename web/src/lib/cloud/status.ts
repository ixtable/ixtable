import type { Entitlement } from "./types";

export type StatusTone = "success" | "warning" | "danger" | "neutral";

/** Maps app_entitlement() to the status shown in the dashboard. */
export function entitlementStatus(entitlement: Entitlement | null | undefined): {
  label: string;
  tone: StatusTone;
  help: string;
} {
  switch (entitlement?.reason) {
    case "ok":
      return { label: "Active", tone: "success", help: "Runtime users can install and sync." };
    case "grace":
      return {
        label: "Payment overdue",
        tone: "warning",
        help: "Access continues for 7 days after the period ends. Update the payment method.",
      };
    case "no_subscription":
      return {
        label: "No plan",
        tone: "warning",
        help: "Choose a plan before you publish or invite runtime users.",
      };
    case "subscription_inactive":
      return {
        label: "Inactive",
        tone: "danger",
        help: "The subscription ended. Runtime users cannot sync or get credential keys.",
      };
    case "over_allowance":
      return {
        label: "Over allowance",
        tone: "danger",
        help: "More active runtime users than the plan allows. Upgrade or revoke users.",
      };
    case "app_deleted":
      return { label: "Deleted", tone: "neutral", help: "This app was deleted." };
    default:
      return { label: "Unknown", tone: "neutral", help: "Status is not available." };
  }
}
