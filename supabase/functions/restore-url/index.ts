// Signed download URL for restoring a checkpoint into a new local copy (PRD
// §23). Exactly one of versionId (Developer/Owner only: the developer
// stream) or backupId (the app owner, or the user whose installation made
// the backup: installation streams are never shared between users). For
// PostgreSQL apps the response says that external records are not restored,
// so the client shows it before restoring. URL valid 15 minutes. Audits
// version.restore or backup.restore.
//
// POST {appId, versionId} | {appId, backupId}
//   → {signedUrl, sha256, size, isPostgres, warning, kind, id, expiresAt}
import { audit } from "../_shared/audit.ts";
import { serviceClient } from "../_shared/db.ts";
import {
  loadApp,
  PG_RESTORE_WARNING,
  requireAppOwner,
  signedDownloadUrl,
  type VersionRow,
} from "../_shared/distribution.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { uuid } from "../_shared/validate.ts";

interface BackupRow {
  id: string;
  app_id: string;
  user_id: string;
  installation_id: string;
  storage_path: string;
  archive_sha256: string;
  archive_size: number;
}

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const versionId = uuid(body, "versionId", { optional: true });
    const backupId = uuid(body, "backupId", { optional: true });
    if (!versionId === !backupId)
      throw new HttpError("VALIDATION", "versionId or backupId: exactly one is required", {
        field: "versionId",
      });

    await enforceRateLimit(`restore-url:${user.id}`, 60, 3600);
    const app = await loadApp(appId);
    const db = serviceClient();
    let target: { path: string; sha256: string; size: number; postgres: boolean };
    if (versionId) {
      requireAppOwner(app, user.id);
      const version = (await db.from("app_versions").select("*").eq("id", versionId).maybeSingle())
        .data as VersionRow | null;
      if (!version || version.app_id !== appId)
        throw new HttpError("NOT_FOUND", "Version not found");
      target = {
        path: version.storage_path,
        sha256: version.archive_sha256,
        size: Number(version.archive_size),
        postgres: app.datasource_kind === "postgres" || version.security?.store === "postgres",
      };
    } else {
      const backup = (
        await db.from("installation_backups").select("*").eq("id", backupId).maybeSingle()
      ).data as BackupRow | null;
      if (!backup || backup.app_id !== appId) throw new HttpError("NOT_FOUND", "Backup not found");
      if (backup.user_id !== user.id && app.owner_id !== user.id)
        throw new HttpError("FORBIDDEN", "This backup belongs to another user's installation");
      target = {
        path: backup.storage_path,
        sha256: backup.archive_sha256,
        size: Number(backup.archive_size),
        postgres: app.datasource_kind === "postgres",
      };
    }

    const signed = await signedDownloadUrl(target.path, req);
    await audit({
      action: versionId ? "version.restore" : "backup.restore",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: versionId ? `version:${versionId}` : `backup:${backupId}`,
      details: { isPostgres: target.postgres, archiveSha256: target.sha256 },
      req,
    });
    await incrementMetric(versionId ? "restore.version" : "restore.backup");
    return {
      signedUrl: signed.url,
      sha256: target.sha256,
      size: target.size,
      isPostgres: target.postgres,
      warning: target.postgres ? PG_RESTORE_WARNING : null,
      kind: versionId ? "version" : "backup",
      id: versionId ?? backupId,
      expiresAt: signed.expiresAt,
    };
  }),
);
