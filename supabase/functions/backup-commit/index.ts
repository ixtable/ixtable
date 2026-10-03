// Records an uploaded installation backup in that installation's stream
// (PRD §23). Only when the Developer enabled backups (403 otherwise). The
// caller must be the owner or an active Runtime User, the upload must be the
// caller's pending backup upload for exactly this installation, and the
// stored object must have the declared size. Streams are keyed by app, user
// and installation and never merged; clients list their own through RLS
// (installation_backups: own rows, or every row for app admins). Developer
// checkpoints are app_versions (publish-checkpoint), never backups. Audits
// backup.upload.
//
// POST {appId, uploadId, installationId} → {backup}
import { audit } from "../_shared/audit.ts";
import { serviceClient } from "../_shared/db.ts";
import {
  type InstallationRow,
  loadApp,
  loadPendingUpload,
  requireRuntimeAccess,
  rpc,
  verifyUploadedObject,
} from "../_shared/distribution.ts";
import { requireEntitlement } from "../_shared/entitlements.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const uploadId = uuid(body, "uploadId");
    const installationId = uuid(body, "installationId");

    await enforceNamedRateLimit("backup-commit", user.id);
    const app = await loadApp(appId);
    await requireRuntimeAccess(app, user.id);
    if (!app.backups_enabled)
      throw new HttpError("FORBIDDEN", "The Developer has not enabled backups for this app");
    await requireEntitlement(appId);
    const { data } = await serviceClient()
      .from("installations")
      .select("*")
      .eq("id", installationId)
      .maybeSingle();
    const installation = data as InstallationRow | null;
    if (!installation || installation.app_id !== appId || installation.user_id !== user.id)
      throw new HttpError("FORBIDDEN", "This installation belongs to another user or app");
    if (installation.revoked_at) throw new HttpError("REVOKED", "This installation was revoked");

    const upload = await loadPendingUpload(uploadId, { appId, userId: user.id, kind: "backup" });
    if (upload.installation_id !== installationId)
      throw new HttpError("VALIDATION", "uploadId: was issued for another installation", {
        field: "uploadId",
      });
    await verifyUploadedObject(upload);
    const backup = await rpc<Record<string, unknown>>("distribution_commit_backup", {
      p_app_id: appId,
      p_upload_id: uploadId,
      p_user_id: user.id,
      p_installation_id: installationId,
    });

    await audit({
      action: "backup.upload",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `backup:${uploadId}`,
      details: {
        installationId,
        archiveSha256: upload.expected_sha256,
        archiveSize: Number(upload.expected_size),
      },
      req,
    });
    await incrementMetric("backups.upload");
    return { backup };
  }),
);
