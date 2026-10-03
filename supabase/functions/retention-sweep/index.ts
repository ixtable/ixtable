// Enforces each app's retention policy (PRD §23). Service role or cron only:
// `Authorization: Bearer <service role key>`, or `x-cron-secret: <CRON_SECRET>`
// when that secret is configured. For every live app (or only `appId`):
// - versions: keep the newest `retention_versions`, and drop any older than
//   `retention_days` (when set). Never the head version, and never a version
//   an installation reports as installed (sync-check).
// - backups: per installation stream, the same rule; the newest backup of
//   each installation is always kept.
// - uploads: pending uploads past their expiry become "expired" and any
//   stored object is removed.
// - desktop sign-in requests (desktop_auth_requests) expired over an hour
//   ago are deleted (only on a full sweep, not with `appId`).
// Storage objects are removed first; rows are deleted only for objects that
// are gone. Audits retention.sweep per app that lost anything.
//
// POST {appId?} → {deleted, versions, backups, uploads, desktopAuthRequests}
import { audit } from "../_shared/audit.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { ARCHIVE_BUCKET, optionalEnv, serviceClient } from "../_shared/db.ts";
import { type AppRow, expiredIds, type RetentionItem } from "../_shared/distribution.ts";
import { bearerToken, handler, HttpError, readJson } from "../_shared/http.ts";
import { incrementMetric } from "../_shared/rateLimit.ts";
import { uuid } from "../_shared/validate.ts";

function authorize(req: Request): void {
  const cron = optionalEnv("CRON_SECRET");
  const header = req.headers.get("x-cron-secret");
  if (cron && header && timingSafeEqual(header, cron)) return;
  const token = bearerToken(req);
  const service = optionalEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (token && service && timingSafeEqual(token, service)) return;
  if (!token && !header) throw new HttpError("UNAUTHENTICATED", "Service credentials required");
  throw new HttpError("FORBIDDEN", "retention-sweep runs only as the service or the scheduler");
}

async function removeObjects(paths: string[]): Promise<Set<string>> {
  const removed = new Set<string>();
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const { error } = await serviceClient().storage.from(ARCHIVE_BUCKET).remove(batch);
    // Storage reports success for paths that were already gone.
    if (!error) for (const path of batch) removed.add(path);
  }
  return removed;
}

async function sweepApp(app: AppRow, now: Date) {
  const db = serviceClient();
  const policy = { keep: app.retention_versions, days: app.retention_days, now };

  const [{ data: versions }, { data: installed }] = await Promise.all([
    db.from("app_versions").select("id, created_at, storage_path").eq("app_id", app.id),
    db
      .from("installations")
      .select("installed_version_id")
      .eq("app_id", app.id)
      .not("installed_version_id", "is", null),
  ]);
  const keepVersions = new Set<string>([
    ...(app.head_version_id ? [app.head_version_id] : []),
    ...(installed ?? []).map((row) => row.installed_version_id as string),
  ]);
  const versionItems: RetentionItem[] = (versions ?? []).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    protected: keepVersions.has(row.id),
  }));
  const expiredVersions = new Set(expiredIds(versionItems, policy));
  const versionRows = (versions ?? []).filter((row) => expiredVersions.has(row.id));

  const { data: backups } = await db
    .from("installation_backups")
    .select("id, installation_id, created_at, storage_path")
    .eq("app_id", app.id);
  const streams = new Map<string, typeof backups>();
  for (const row of backups ?? []) {
    const list = streams.get(row.installation_id) ?? [];
    list.push(row);
    streams.set(row.installation_id, list);
  }
  const backupRows: { id: string; storage_path: string }[] = [];
  for (const rows of streams.values()) {
    const newest = [...(rows ?? [])].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    )[0];
    const expired = new Set(
      expiredIds(
        (rows ?? []).map((row) => ({
          id: row.id,
          createdAt: row.created_at,
          protected: row.id === newest?.id,
        })),
        policy,
      ),
    );
    backupRows.push(...(rows ?? []).filter((row) => expired.has(row.id)));
  }

  const removed = await removeObjects(
    [...versionRows, ...backupRows].map((row) => row.storage_path),
  );
  const versionIds = versionRows
    .filter((row) => removed.has(row.storage_path))
    .map((row) => row.id);
  const backupIds = backupRows.filter((row) => removed.has(row.storage_path)).map((row) => row.id);
  if (versionIds.length > 0) {
    const { error } = await db.from("app_versions").delete().in("id", versionIds);
    if (error) throw new Error(`delete versions: ${error.message}`);
  }
  if (backupIds.length > 0) {
    const { error } = await db.from("installation_backups").delete().in("id", backupIds);
    if (error) throw new Error(`delete backups: ${error.message}`);
  }
  if (versionIds.length + backupIds.length > 0) {
    await audit({
      action: "retention.sweep",
      orgId: app.org_id,
      appId: app.id,
      target: `app:${app.id}`,
      details: {
        versions: versionIds,
        backups: backupIds,
        retentionVersions: app.retention_versions,
        retentionDays: app.retention_days,
      },
    });
  }
  return { versions: versionIds.length, backups: backupIds.length };
}

async function expireUploads(appId: string | undefined, now: Date): Promise<number> {
  const db = serviceClient();
  let query = db
    .from("archive_uploads")
    .select("id, storage_path")
    .eq("status", "pending")
    .lt("expires_at", now.toISOString())
    .limit(1000);
  if (appId) query = query.eq("app_id", appId);
  const { data } = await query;
  if (!data || data.length === 0) return 0;
  const removed = await removeObjects(data.map((row) => row.storage_path));
  const ids = data.filter((row) => removed.has(row.storage_path)).map((row) => row.id);
  if (ids.length > 0)
    await db
      .from("archive_uploads")
      .update({ status: "expired" })
      .in("id", ids)
      .eq("status", "pending");
  return ids.length;
}

async function purgeDesktopAuthRequests(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 3_600_000).toISOString();
  const { data, error } = await serviceClient()
    .from("desktop_auth_requests")
    .delete()
    .lt("expires_at", cutoff)
    .select("id");
  if (error) throw new Error(`purge desktop auth requests: ${error.message}`);
  return (data ?? []).length;
}

Deno.serve(
  handler(async (req) => {
    authorize(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId", { optional: true });
    const now = new Date();
    const db = serviceClient();
    let query = db.from("cloud_apps").select("*").is("deleted_at", null);
    if (appId) query = query.eq("id", appId);
    const { data: apps, error } = await query;
    if (error) throw new Error(`load apps: ${error.message}`);

    let versions = 0;
    let backups = 0;
    for (const app of (apps ?? []) as AppRow[]) {
      const result = await sweepApp(app, now);
      versions += result.versions;
      backups += result.backups;
    }
    const uploads = await expireUploads(appId, now);
    const desktopAuthRequests = appId ? 0 : await purgeDesktopAuthRequests(now);
    await incrementMetric("retention.deleted", versions + backups);
    return { deleted: versions + backups, versions, backups, uploads, desktopAuthRequests };
  }),
);
