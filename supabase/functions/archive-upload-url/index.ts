// Hands out a signed upload URL for one `.ixt` archive (PRD §7.4, §23).
// kind "version": the Developer/Owner uploads a checkpoint to
//   apps/<appId>/versions/<uploadId>.ixt, later committed by
//   publish-checkpoint or versions-resolve.
// kind "backup": the owner or an active Runtime User uploads an installation
//   backup to apps/<appId>/installations/<userId>/<installationId>/<uploadId>.ixt,
//   later committed by backup-commit. Needs backups enabled on the app; the
//   installation is registered for the caller if new (403 when it is someone
//   else's or revoked).
// The client's size and sha256 are recorded; the commit checks the stored
// object's size. Over 500 MB → 413 TOO_LARGE. Needs an entitled app. The
// signed URL (Storage `createSignedUploadUrl`, valid 2 hours, no upsert)
// accepts one PUT. Audits archive.upload.
//
// POST {appId, kind, size, sha256, installationId?}
//   → {uploadId, path, signedUrl, token, expiresAt}
import { audit } from "../_shared/audit.ts";
import { ARCHIVE_BUCKET, MAX_ARCHIVE_BYTES, serviceClient } from "../_shared/db.ts";
import {
  backupPath,
  loadApp,
  publicUrl,
  requireAppOwner,
  requireRuntimeAccess,
  touchInstallation,
  versionPath,
} from "../_shared/distribution.ts";
import { requireEntitlement } from "../_shared/entitlements.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { int, oneOf, sha256, uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const kind = oneOf(body, "kind", ["version", "backup"] as const);
    const size = int(body, "size", { min: 1 });
    if (size > MAX_ARCHIVE_BYTES)
      throw new HttpError("TOO_LARGE", "Archives are limited to 500 MB in ixtable Cloud", {
        maxBytes: MAX_ARCHIVE_BYTES,
        size,
      });
    const digest = sha256(body, "sha256");
    const installationId =
      kind === "backup"
        ? uuid(body, "installationId")
        : uuid(body, "installationId", { optional: true });

    await enforceRateLimit(`archive-upload-url:${user.id}`, 60, 3600);
    const app = await loadApp(appId);
    const uploadId = crypto.randomUUID();
    let path: string;
    if (kind === "version") {
      requireAppOwner(app, user.id);
      await requireEntitlement(appId);
      path = versionPath(appId, uploadId);
    } else {
      await requireRuntimeAccess(app, user.id);
      if (!app.backups_enabled)
        throw new HttpError("FORBIDDEN", "The Developer has not enabled backups for this app");
      await requireEntitlement(appId);
      await touchInstallation(app, user.id, installationId as string);
      path = backupPath(appId, user.id, installationId as string, uploadId);
    }

    const db = serviceClient();
    const { data: upload, error } = await db
      .from("archive_uploads")
      .insert({
        id: uploadId,
        app_id: appId,
        user_id: user.id,
        kind,
        installation_id: kind === "backup" ? installationId : null,
        storage_path: path,
        expected_size: size,
        expected_sha256: digest,
      })
      .select("id, expires_at")
      .single();
    if (error || !upload) throw new Error(`record upload: ${error?.message}`);

    const signed = await db.storage.from(ARCHIVE_BUCKET).createSignedUploadUrl(path);
    if (signed.error || !signed.data) {
      await db.from("archive_uploads").update({ status: "failed" }).eq("id", uploadId);
      throw new Error(`createSignedUploadUrl: ${signed.error?.message}`);
    }

    await audit({
      action: "archive.upload",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `upload:${uploadId}`,
      details: { kind, size, sha256: digest, installationId: installationId ?? null },
      req,
    });
    await incrementMetric(`uploads.${kind}`);
    return {
      uploadId,
      path,
      signedUrl: publicUrl(signed.data.signedUrl, req),
      token: signed.data.token,
      expiresAt: upload.expires_at,
    };
  }),
);
