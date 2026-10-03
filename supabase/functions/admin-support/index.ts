// admin-support {query:{email?|appId?}} → {diagnostics}
// Operators only (profiles.is_operator). Diagnoses distribution and key-grant
// failures without viewing secrets (PRD Phase 5): account state, memberships,
// installations, entitlement and subscription, latest published version,
// key-grant history, recent distribution/key/billing audit events and
// service metrics. Built from explicit field lists: never DEKs, envelope
// ciphertext, nonces, wrapped keys, token hashes, IP hashes or provider ids.
// Every lookup is audited as admin.lookup.
import { audit, redactSecrets } from "../_shared/audit.ts";
import { serviceClient } from "../_shared/db.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit } from "../_shared/rateLimit.ts";
import { email, record, uuid } from "../_shared/validate.ts";

type Row = Record<string, unknown>;
const NIL = "00000000-0000-0000-0000-000000000000";
const FAILURE = /(fail|denied|refused|rejected|error|revoke)/;
const AUDIT_PREFIXES = [
  "bundle.",
  "key.",
  "credential.",
  "member.",
  "device.",
  "installation.",
  "version.",
  "auth.",
  "billing.",
  "invitation.",
  "backup.",
  "app.",
];
const METRIC_PREFIXES = [
  "key",
  "bundle",
  "billing",
  "auth",
  "publish",
  "credential",
  "desktop",
  "storage",
];

async function list(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  what: string,
): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw new Error(`${what} failed: ${error.message}`);
  return (data as Row[] | null) ?? [];
}

function auditView(event: Row): Row {
  return {
    at: event.at,
    action: event.action,
    actorId: event.actor_id,
    appId: event.app_id,
    target: event.target,
    details: redactSecrets(event.details ?? {}),
  };
}

async function appDiagnostics(appIds: string[]): Promise<Row[]> {
  const db = serviceClient();
  const ids = appIds.length > 0 ? appIds : [NIL];
  const [apps, subscriptions, versions, envelopes, webhooks] = await Promise.all([
    list(
      db
        .from("cloud_apps")
        .select(
          "id, name, org_id, owner_id, datasource_kind, backups_enabled, head_version_id, created_at, deleted_at",
        )
        .in("id", ids),
      "apps",
    ),
    list(
      db
        .from("subscriptions")
        .select(
          "app_id, plan_id, provider, status, current_period_end, cancel_at_period_end, stripe_customer_id, updated_at",
        )
        .in("app_id", ids),
      "subscriptions",
    ),
    list(
      db
        .from("app_versions")
        .select("id, app_id, version, status, published_at, min_runtime_version, archive_size")
        .in("app_id", ids)
        .eq("status", "published")
        .order("published_at", { ascending: false }),
      "versions",
    ),
    list(
      db
        .from("credential_envelopes")
        .select("app_id, datasource_id, scope, user_id, kek_version, updated_at, revoked_at")
        .in("app_id", ids),
      "credential status",
    ),
    list(
      db
        .from("billing_events")
        .select("app_id, type, outcome, outcome_reason, received_at, processed_at")
        .in("app_id", ids)
        .order("received_at", { ascending: false })
        .limit(20),
      "billing events",
    ),
  ]);
  return Promise.all(
    apps.map(async (app) => {
      const { data: entitlement } = await db.rpc("app_entitlement", { p_app_id: app.id });
      const subscription = subscriptions.find((s) => s.app_id === app.id);
      const latest = versions.find((v) => v.app_id === app.id);
      return {
        id: app.id,
        name: app.name,
        orgId: app.org_id,
        ownerId: app.owner_id,
        datasourceKind: app.datasource_kind,
        backupsEnabled: app.backups_enabled,
        createdAt: app.created_at,
        deletedAt: app.deleted_at,
        headVersionId: app.head_version_id,
        latestPublished: latest
          ? {
              id: latest.id,
              version: latest.version,
              publishedAt: latest.published_at,
              minRuntimeVersion: latest.min_runtime_version,
              size: latest.archive_size,
            }
          : null,
        entitlement,
        subscription: subscription
          ? {
              planId: subscription.plan_id,
              provider: subscription.provider,
              status: subscription.status,
              currentPeriodEnd: subscription.current_period_end,
              cancelAtPeriodEnd: subscription.cancel_at_period_end,
              hasBillingCustomer: Boolean(subscription.stripe_customer_id),
              updatedAt: subscription.updated_at,
            }
          : null,
        credentialStatus: envelopes
          .filter((e) => e.app_id === app.id)
          .map((e) => ({
            datasourceId: e.datasource_id,
            scope: e.scope,
            userId: e.user_id,
            kekVersion: e.kek_version,
            updatedAt: e.updated_at,
            revoked: Boolean(e.revoked_at),
          })),
        recentWebhooks: webhooks
          .filter((w) => w.app_id === app.id)
          .slice(0, 5)
          .map((w) => ({
            type: w.type,
            outcome: w.outcome,
            reason: w.outcome_reason,
            receivedAt: w.received_at,
            processed: Boolean(w.processed_at),
          })),
      };
    }),
  );
}

function summarizeEvents(events: Row[]): Row {
  const relevant = events.filter((e) =>
    AUDIT_PREFIXES.some((prefix) => String(e.action).startsWith(prefix)),
  );
  const first = (pred: (action: string) => boolean) => {
    const found = relevant.find((e) => pred(String(e.action)));
    return found ? auditView(found) : null;
  };
  return {
    lastBundleGenerate: first((a) => a === "bundle.generate"),
    lastKeyIssue: first((a) => a === "key.issue" || a === "key.renew"),
    recentFailures: relevant
      .filter(
        (e) => FAILURE.test(String(e.action)) || (e.details as Row | null)?.error !== undefined,
      )
      .slice(0, 20)
      .map(auditView),
    recent: relevant.slice(0, 50).map(auditView),
  };
}

async function metrics(): Promise<Row[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const rows = await list(
    serviceClient()
      .from("service_metrics")
      .select("name, day, count")
      .gte("day", since)
      .order("day", { ascending: false }),
    "metrics",
  );
  return rows.filter((row) =>
    METRIC_PREFIXES.some((prefix) => String(row.name).startsWith(prefix)),
  );
}

function installationView(i: Row): Row {
  return {
    id: i.id,
    appId: i.app_id,
    userId: i.user_id,
    deviceName: i.device_name,
    installedVersionId: i.installed_version_id,
    createdAt: i.created_at,
    lastSeenAt: i.last_seen_at,
    revoked: Boolean(i.revoked_at),
    revokedAt: i.revoked_at,
  };
}

function grantView(g: Row): Row {
  const expired = Date.parse(String(g.expires_at)) < Date.now();
  return {
    id: g.id,
    appId: g.app_id,
    userId: g.user_id,
    installationId: g.installation_id,
    datasourceId: g.datasource_id,
    issuedAt: g.issued_at,
    expiresAt: g.expires_at,
    expired,
    revoked: Boolean(g.revoked_at),
  };
}

async function byUser(userEmail: string): Promise<{ diagnostics: Row; target: string | null }> {
  const db = serviceClient();
  const [profile] = await list(
    db
      .from("profiles")
      .select("id, email, display_name, is_operator, created_at")
      .eq("email", userEmail)
      .limit(1),
    "profile",
  );
  if (!profile)
    return { diagnostics: { query: { email: userEmail }, user: { exists: false } }, target: null };
  const uid = String(profile.id);
  const { data: auth } = await db.auth.admin.getUserById(uid);
  const authUser = auth?.user;
  const [orgs, memberships, owned, installations, grants, events] = await Promise.all([
    list(
      db.from("org_members").select("org_id, role, organizations(name)").eq("user_id", uid),
      "org memberships",
    ),
    list(
      db
        .from("app_members")
        .select("app_id, role_id, status, created_at, revoked_at, cloud_apps(name)")
        .eq("user_id", uid),
      "app memberships",
    ),
    list(db.from("cloud_apps").select("id").eq("owner_id", uid), "owned apps"),
    list(
      db
        .from("installations")
        .select(
          "id, app_id, user_id, device_name, installed_version_id, created_at, last_seen_at, revoked_at",
        )
        .eq("user_id", uid)
        .order("last_seen_at", { ascending: false })
        .limit(50),
      "installations",
    ),
    list(
      db
        .from("key_grants")
        .select(
          "id, app_id, user_id, installation_id, datasource_id, issued_at, expires_at, revoked_at",
        )
        .eq("user_id", uid)
        .order("issued_at", { ascending: false })
        .limit(20),
      "key grants",
    ),
    list(
      db
        .from("audit_events")
        .select("at, action, actor_id, app_id, target, details")
        .or(`actor_id.eq.${uid},target.eq.user:${uid}`)
        .order("at", { ascending: false })
        .limit(200),
      "audit",
    ),
  ]);
  const roleIds = memberships.map((m) => String(m.role_id));
  const roles = await list(
    db
      .from("app_roles")
      .select("app_id, id, name")
      .in("id", roleIds.length > 0 ? roleIds : [NIL]),
    "roles",
  );
  const appIds = [
    ...new Set([...memberships.map((m) => String(m.app_id)), ...owned.map((a) => String(a.id))]),
  ];
  return {
    target: `user:${uid}`,
    diagnostics: {
      query: { email: userEmail },
      user: {
        exists: true,
        id: uid,
        email: profile.email,
        displayName: profile.display_name,
        isOperator: profile.is_operator,
        confirmed: Boolean(authUser?.email_confirmed_at),
        createdAt: authUser?.created_at ?? profile.created_at,
        lastSignInAt: authUser?.last_sign_in_at ?? null,
        bannedUntil: (authUser as { banned_until?: string } | undefined)?.banned_until ?? null,
        providers: (authUser?.app_metadata?.providers as string[] | undefined) ?? [],
      },
      orgMemberships: orgs.map((o) => ({
        orgId: o.org_id,
        orgName: (o.organizations as Row | null)?.name ?? null,
        role: o.role,
      })),
      appMemberships: memberships.map((m) => ({
        appId: m.app_id,
        appName: (m.cloud_apps as Row | null)?.name ?? null,
        roleId: m.role_id,
        roleName: roles.find((r) => r.app_id === m.app_id && r.id === m.role_id)?.name ?? null,
        status: m.status,
        createdAt: m.created_at,
        revokedAt: m.revoked_at,
      })),
      ownedAppIds: owned.map((a) => a.id),
      installations: installations.map(installationView),
      recentKeyGrants: grants.map(grantView),
      events: summarizeEvents(events),
      apps: await appDiagnostics(appIds),
      metrics: await metrics(),
    },
  };
}

async function byApp(appId: string): Promise<{ diagnostics: Row; target: string | null }> {
  const db = serviceClient();
  const [apps] = await Promise.all([appDiagnostics([appId])]);
  if (apps.length === 0) return { diagnostics: { query: { appId }, app: null }, target: null };
  const [members, installations, grants, events] = await Promise.all([
    list(
      db
        .from("app_members")
        .select("user_id, role_id, status, created_at, revoked_at")
        .eq("app_id", appId),
      "members",
    ),
    list(
      db
        .from("installations")
        .select(
          "id, app_id, user_id, device_name, installed_version_id, created_at, last_seen_at, revoked_at",
        )
        .eq("app_id", appId)
        .order("last_seen_at", { ascending: false })
        .limit(100),
      "installations",
    ),
    list(
      db
        .from("key_grants")
        .select(
          "id, app_id, user_id, installation_id, datasource_id, issued_at, expires_at, revoked_at",
        )
        .eq("app_id", appId)
        .order("issued_at", { ascending: false })
        .limit(20),
      "key grants",
    ),
    list(
      db
        .from("audit_events")
        .select("at, action, actor_id, app_id, target, details")
        .eq("app_id", appId)
        .order("at", { ascending: false })
        .limit(200),
      "audit",
    ),
  ]);
  const userIds = members.map((m) => String(m.user_id));
  const profiles = await list(
    db
      .from("profiles")
      .select("id, email")
      .in("id", userIds.length > 0 ? userIds : [NIL]),
    "profiles",
  );
  return {
    target: `app:${appId}`,
    diagnostics: {
      query: { appId },
      app: apps[0],
      members: members.map((m) => ({
        userId: m.user_id,
        email: profiles.find((p) => p.id === m.user_id)?.email ?? null,
        roleId: m.role_id,
        status: m.status,
        createdAt: m.created_at,
        revokedAt: m.revoked_at,
      })),
      installations: installations.map(installationView),
      recentKeyGrants: grants.map(grantView),
      events: summarizeEvents(events),
      metrics: await metrics(),
    },
  };
}

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    await enforceNamedRateLimit("admin-support", user.id);
    const db = serviceClient();
    const { data: me } = await db
      .from("profiles")
      .select("is_operator")
      .eq("id", user.id)
      .maybeSingle();
    if (!me?.is_operator) throw new HttpError("FORBIDDEN", "Support operators only");

    const query = record(body, "query");
    const hasEmail = query.email !== undefined && query.email !== null && query.email !== "";
    const hasApp = query.appId !== undefined && query.appId !== null && query.appId !== "";
    if (hasEmail === hasApp) {
      throw new HttpError("VALIDATION", "query: give exactly one of email or appId", {
        field: "query",
      });
    }
    const result = hasEmail
      ? await byUser(email(query, "email"))
      : await byApp(uuid(query, "appId"));
    await audit({
      action: "admin.lookup",
      actorId: user.id,
      appId: hasApp ? String(query.appId) : null,
      target: result.target,
      details: { by: hasEmail ? "email" : "appId", found: result.target !== null },
      req,
    });
    return { diagnostics: result.diagnostics };
  }),
);
