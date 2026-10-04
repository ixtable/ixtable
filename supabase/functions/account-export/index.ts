// account-export {} → {export, archives: string[]}
// The caller's own data (PRD Phase 5, §29): profile, organizations and
// memberships, apps they own (metadata, versions, roles, subscriptions,
// credential envelope metadata), their installations, backups and key grant
// history, invitations they sent or received, and audit events about them.
// `archives` are short-lived signed URLs for archives they own (their apps'
// versions and their installation backups), indexed in export.archives.
// Never included: ciphertext, nonces, wrapped DEKs, token hashes, IP hashes.
import { audit } from "../_shared/audit.ts";
import { ARCHIVE_BUCKET, serviceClient } from "../_shared/db.ts";
import { publicUrl } from "../_shared/distribution.ts";
import { handler, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit, incrementMetric } from "../_shared/rateLimit.ts";

const SIGNED_URL_SECONDS = 3600;
const MAX_ARCHIVES = 500;
const MAX_AUDIT = 5000;

type Row = Record<string, unknown>;

async function rows(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  what: string,
): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw new Error(`${what} failed: ${error.message}`);
  return (data as Row[] | null) ?? [];
}

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    await enforceNamedRateLimit("account-export", user.id);
    const db = serviceClient();
    const uid = user.id;

    const [profile] = await rows(
      db
        .from("profiles")
        .select("id, email, display_name, is_operator, created_at, updated_at")
        .eq("id", uid),
      "profile",
    );
    const orgMemberships = await rows(
      db
        .from("org_members")
        .select("org_id, role, created_at, organizations(id, name, created_by, created_at)")
        .eq("user_id", uid),
      "org memberships",
    );
    const apps = await rows(
      db
        .from("cloud_apps")
        .select(
          "id, org_id, name, document_id, datasource_kind, backups_enabled, retention_versions, retention_days, head_version_id, created_at, updated_at, deleted_at",
        )
        .eq("owner_id", uid),
      "apps",
    );
    const appIds = apps.map((app) => String(app.id));
    // `in` with an empty list is invalid PostgREST; the nil uuid matches nothing.
    const ids = appIds.length > 0 ? appIds : ["00000000-0000-0000-0000-000000000000"];

    const [versions, roles, members, subscriptions, envelopes] = await Promise.all([
      rows(
        db
          .from("app_versions")
          .select(
            "id, app_id, version, developer_id, created_at, archive_sha256, archive_size, storage_path, migrations, min_runtime_version, security, release_notes, status, parent_version_id, resolution, published_at, withdrawn_at",
          )
          .in("app_id", ids)
          .order("created_at", { ascending: true }),
        "versions",
      ),
      rows(
        db
          .from("app_roles")
          .select("app_id, id, name, permissions, created_at, updated_at")
          .in("app_id", ids),
        "roles",
      ),
      rows(
        db
          .from("app_members")
          .select("app_id, user_id, role_id, status, created_at, revoked_at")
          .in("app_id", ids),
        "members",
      ),
      rows(
        db
          .from("subscriptions")
          .select(
            "app_id, plan_id, provider, status, current_period_end, cancel_at_period_end, created_at, updated_at",
          )
          .in("app_id", ids),
        "subscriptions",
      ),
      rows(
        db
          .from("credential_envelopes")
          .select(
            "id, app_id, datasource_id, scope, user_id, kek_version, created_at, updated_at, revoked_at",
          )
          .in("app_id", ids),
        "credential envelopes",
      ),
    ]);

    const [
      appMemberships,
      installations,
      backups,
      keyGrants,
      invitationsSent,
      invitationsReceived,
    ] = await Promise.all([
      rows(
        db
          .from("app_members")
          .select("app_id, role_id, status, created_at, revoked_at, cloud_apps(name)")
          .eq("user_id", uid),
        "app memberships",
      ),
      rows(
        db
          .from("installations")
          .select(
            "id, app_id, device_name, installed_version_id, created_at, last_seen_at, revoked_at",
          )
          .eq("user_id", uid),
        "installations",
      ),
      rows(
        db
          .from("installation_backups")
          .select(
            "id, app_id, installation_id, storage_path, archive_sha256, archive_size, created_at",
          )
          .eq("user_id", uid),
        "backups",
      ),
      rows(
        db
          .from("key_grants")
          .select("id, app_id, installation_id, datasource_id, issued_at, expires_at, revoked_at")
          .eq("user_id", uid),
        "key grants",
      ),
      rows(
        db
          .from("invitations")
          .select(
            "id, kind, org_id, app_id, email, org_role, role_id, created_at, expires_at, accepted_at, revoked_at",
          )
          .eq("invited_by", uid),
        "invitations sent",
      ),
      rows(
        db
          .from("invitations")
          .select(
            "id, kind, org_id, app_id, email, org_role, role_id, created_at, expires_at, accepted_at, revoked_at",
          )
          .eq("email", (user.email ?? "").toLowerCase()),
        "invitations received",
      ),
    ]);

    const auditFilter = [`actor_id.eq.${uid}`, `target.eq.user:${uid}`];
    if (appIds.length > 0) auditFilter.push(`app_id.in.(${appIds.join(",")})`);
    const auditEvents = await rows(
      db
        .from("audit_events")
        .select("id, at, actor_id, org_id, app_id, action, target, details")
        .or(auditFilter.join(","))
        .order("at", { ascending: false })
        .limit(MAX_AUDIT),
      "audit events",
    );

    // Archives the caller owns: their apps' versions and their own backups.
    const archiveIndex = [
      ...versions.map((v) => ({
        kind: "version",
        appId: v.app_id,
        id: v.id,
        version: v.version,
        sha256: v.archive_sha256,
        size: v.archive_size,
        path: String(v.storage_path),
      })),
      ...backups.map((b) => ({
        kind: "backup",
        appId: b.app_id,
        id: b.id,
        installationId: b.installation_id,
        sha256: b.archive_sha256,
        size: b.archive_size,
        path: String(b.storage_path),
      })),
    ].slice(0, MAX_ARCHIVES);
    const archives: string[] = [];
    const indexed: Row[] = [];
    if (archiveIndex.length > 0) {
      const { data: signed, error } = await db.storage.from(ARCHIVE_BUCKET).createSignedUrls(
        archiveIndex.map((entry) => entry.path),
        SIGNED_URL_SECONDS,
      );
      if (error) throw new Error(`sign archive URLs failed: ${error.message}`);
      const expiresAt = new Date(Date.now() + SIGNED_URL_SECONDS * 1000).toISOString();
      for (const [index, entry] of archiveIndex.entries()) {
        const url = signed?.[index]?.signedUrl;
        // Pending or swept versions have no object.
        if (!url || signed?.[index]?.error) continue;
        const { path: _path, ...meta } = entry;
        indexed.push({ ...meta, urlIndex: archives.length, expiresAt });
        archives.push(publicUrl(url));
      }
    }

    await audit({
      action: "account.export",
      actorId: uid,
      target: `user:${uid}`,
      details: { apps: appIds.length, archives: archives.length, auditEvents: auditEvents.length },
      req,
    });
    await incrementMetric("account.export");

    const strip = (list: Row[]) => list.map(({ storage_path: _storage, ...rest }) => rest);
    return {
      export: {
        format: "ixtable-cloud-account-export/1",
        exportedAt: new Date().toISOString(),
        user: {
          id: uid,
          email: user.email ?? null,
          createdAt: user.created_at,
          emailConfirmedAt: user.email_confirmed_at ?? null,
          lastSignInAt: user.last_sign_in_at ?? null,
          providers: (user.app_metadata?.providers as string[] | undefined) ?? [],
        },
        profile: profile ?? null,
        organizations: orgMemberships,
        apps: apps.map((app) => ({
          ...app,
          versions: strip(versions.filter((v) => v.app_id === app.id)),
          roles: roles.filter((r) => r.app_id === app.id),
          members: members.filter((m) => m.app_id === app.id),
          subscription: subscriptions.find((s) => s.app_id === app.id) ?? null,
          credentialEnvelopes: envelopes.filter((e) => e.app_id === app.id),
        })),
        appMemberships,
        installations,
        backups: strip(backups),
        keyGrants,
        invitations: { sent: invitationsSent, received: invitationsReceived },
        auditEvents,
        archives: indexed,
      },
      archives,
    };
  }),
);
