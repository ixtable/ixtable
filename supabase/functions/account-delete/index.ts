// account-delete {confirmEmail, cancelSubscriptions?} → {}
// Deletes the caller's account (PRD Phase 5, §29).
// Refuses (403 FORBIDDEN, details.reason):
// - "active_subscriptions": the caller owns apps whose subscription still
//   bills, unless cancelSubscriptions:true (then each is canceled with the
//   provider at once);
// - "sole_org_owner": the caller is the only owner of an organization that
//   has other members or apps owned by someone else (transfer ownership first).
// Then: owned apps are soft-deleted (audited), their archive objects and the
// caller's installation backups are removed from storage, the app rows are
// purged (cloud_apps.owner_id is ON DELETE RESTRICT), organizations where
// the caller was the only member are deleted, and the auth user is deleted
// through the admin API (memberships, installations and grants cascade).
// Audit rows stay and keep the caller's id as actor.
import { audit } from "../_shared/audit.ts";
import { billingProvider, ENDED_STATUSES } from "../_shared/billing.ts";
import { ARCHIVE_BUCKET, serviceClient } from "../_shared/db.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { bool, str } from "../_shared/validate.ts";

const REMOVE_BATCH = 100;

async function must<T>(
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
  what: string,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`${what} failed: ${error.message}`);
  return (data ?? []) as T;
}

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const confirmEmail = str(body, "confirmEmail", { min: 3, max: 320 }).trim().toLowerCase();
    const cancelSubscriptions = bool(body, "cancelSubscriptions", { optional: true }) ?? false;
    await enforceNamedRateLimit("account-delete", user.id);
    if (!user.email || confirmEmail !== user.email.toLowerCase()) {
      throw new HttpError("VALIDATION", "confirmEmail: type your account email to confirm", {
        field: "confirmEmail",
      });
    }
    const uid = user.id;
    const db = serviceClient();

    const apps = await must<
      { id: string; org_id: string; name: string; deleted_at: string | null }[]
    >(
      db.from("cloud_apps").select("id, org_id, name, deleted_at").eq("owner_id", uid),
      "load apps",
    );
    const appIds = apps.map((app) => app.id);
    const subscriptions =
      appIds.length === 0
        ? []
        : await must<
            {
              app_id: string;
              status: string;
              stripe_subscription_id: string | null;
              plan_id: string;
            }[]
          >(
            db
              .from("subscriptions")
              .select("app_id, status, stripe_subscription_id, plan_id")
              .in("app_id", appIds),
            "load subscriptions",
          );
    const billing = subscriptions.filter((sub) => !ENDED_STATUSES.includes(sub.status));
    if (billing.length > 0 && !cancelSubscriptions) {
      throw new HttpError(
        "FORBIDDEN",
        "You own apps with active subscriptions. Cancel them first, or confirm cancelSubscriptions.",
        { reason: "active_subscriptions", appIds: billing.map((sub) => sub.app_id) },
      );
    }

    // Organizations where the caller is the only owner.
    const memberships = await must<{ org_id: string; role: string }[]>(
      db.from("org_members").select("org_id, role").eq("user_id", uid),
      "load memberships",
    );
    const orgsToDelete: string[] = [];
    const blocked: string[] = [];
    for (const membership of memberships.filter((m) => m.role === "owner")) {
      const others = await must<{ user_id: string; role: string }[]>(
        db
          .from("org_members")
          .select("user_id, role")
          .eq("org_id", membership.org_id)
          .neq("user_id", uid),
        "load org members",
      );
      if (others.some((other) => other.role === "owner")) continue;
      const { count: foreignApps } = await db
        .from("cloud_apps")
        .select("id", { count: "exact", head: true })
        .eq("org_id", membership.org_id)
        .neq("owner_id", uid);
      if (others.length > 0 || (foreignApps ?? 0) > 0) blocked.push(membership.org_id);
      else orgsToDelete.push(membership.org_id);
    }
    if (blocked.length > 0) {
      throw new HttpError(
        "FORBIDDEN",
        "You are the only owner of an organization with other members. Transfer ownership first.",
        { reason: "sole_org_owner", orgIds: blocked },
      );
    }

    // Cancel billing at once (refusal paths above changed nothing).
    const provider = billingProvider();
    for (const sub of billing) {
      if (sub.stripe_subscription_id) {
        await provider.cancelSubscription({
          subscriptionId: sub.stripe_subscription_id,
          atPeriodEnd: false,
        });
      }
      await must(
        db
          .from("subscriptions")
          .update({ status: "canceled", cancel_at_period_end: false })
          .eq("app_id", sub.app_id)
          .select("id"),
        "cancel subscription",
      );
      await audit({
        action: "billing.subscription_canceled",
        actorId: uid,
        appId: sub.app_id,
        target: `plan:${sub.plan_id}`,
        details: { reason: "account_delete", previousStatus: sub.status },
        req,
      });
    }

    // Soft-delete owned apps (audited), then remove their archives.
    const now = new Date().toISOString();
    for (const app of apps) {
      if (!app.deleted_at) {
        await must(
          db.from("cloud_apps").update({ deleted_at: now }).eq("id", app.id).select("id"),
          "soft-delete app",
        );
      }
      await audit({
        action: "app.delete",
        actorId: uid,
        orgId: app.org_id,
        appId: app.id,
        target: `app:${app.id}`,
        details: { reason: "account_delete", name: app.name },
        req,
      });
    }
    const paths = new Set<string>();
    if (appIds.length > 0) {
      for (const table of ["app_versions", "installation_backups", "archive_uploads"]) {
        const found = await must<{ storage_path: string }[]>(
          db.from(table).select("storage_path").in("app_id", appIds),
          `load ${table}`,
        );
        for (const row of found) paths.add(row.storage_path);
      }
    }
    // The caller's own installation backups in apps owned by others.
    for (const table of ["installation_backups", "archive_uploads"]) {
      const found = await must<{ storage_path: string }[]>(
        db.from(table).select("storage_path").eq("user_id", uid),
        `load own ${table}`,
      );
      for (const row of found) paths.add(row.storage_path);
    }
    const allPaths = [...paths];
    for (let index = 0; index < allPaths.length; index += REMOVE_BATCH) {
      const { error } = await db.storage
        .from(ARCHIVE_BUCKET)
        .remove(allPaths.slice(index, index + REMOVE_BATCH));
      if (error) throw new Error(`remove archives failed: ${error.message}`);
    }

    // Purge app rows (cascades versions, roles, members, envelopes, grants,
    // subscriptions) and the organizations nobody else belongs to.
    if (appIds.length > 0) {
      await must(db.from("cloud_apps").delete().in("id", appIds).select("id"), "purge apps");
    }
    if (orgsToDelete.length > 0) {
      await must(
        db.from("organizations").delete().in("id", orgsToDelete).select("id"),
        "delete organizations",
      );
    }

    await audit({
      action: "account.delete",
      actorId: uid,
      target: `user:${uid}`,
      details: {
        appsDeleted: appIds.length,
        orgsDeleted: orgsToDelete.length,
        subscriptionsCanceled: billing.length,
        archivesRemoved: allPaths.length,
      },
      req,
    });
    const { error } = await db.auth.admin.deleteUser(uid);
    if (error) throw new Error(`delete auth user failed: ${error.message}`);
    await incrementMetric("account.delete");
    return {};
  }),
);
