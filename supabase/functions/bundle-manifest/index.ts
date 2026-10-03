// Issues a personalized, signed runtime bundle for the newest published
// version (PRD §21.2, §22.3). The caller must be the owner or an active
// Runtime User (403 FORBIDDEN otherwise, 403 REVOKED when revoked), the app
// must be entitled, and the installation must not be revoked; it is
// registered (or touched) with the device name. The manifest carries the
// caller's role and permissions and an HMAC fingerprint of
// user|version|installation|issuedAt; the signature is Ed25519 over
// canonicalJson(manifest). The archive URL is a 15-minute signed URL.
// Audits bundle.generate.
//
// POST {appId, installationId, deviceName?}
//   → {manifest, signature, archiveUrl, archiveUrlExpiresAt}
import { audit } from "../_shared/audit.ts";
import { bundleFingerprint, canonicalJson, signWithCloudKey } from "../_shared/crypto.ts";
import { serviceClient } from "../_shared/db.ts";
import {
  buildManifest,
  latestPublished,
  loadApp,
  requireRuntimeAccess,
  signedDownloadUrl,
  touchInstallation,
} from "../_shared/distribution.ts";
import { requireEntitlement } from "../_shared/entitlements.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { str, uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const installationId = uuid(body, "installationId");
    const deviceName = (str(body, "deviceName", { optional: true, min: 0, max: 200 }) ?? "").trim();

    await enforceRateLimit(`bundle-manifest:${user.id}`, 60, 3600);
    const app = await loadApp(appId);
    const access = await requireRuntimeAccess(app, user.id);
    await requireEntitlement(appId);
    await touchInstallation(app, user.id, installationId, deviceName);
    const version = await latestPublished(app);
    if (!version) throw new HttpError("NOT_FOUND", "This app has no published version yet");

    let role: { id: string; name: string; permissions: unknown } | null = null;
    if (access.member) {
      const { data } = await serviceClient()
        .from("app_roles")
        .select("id, name, permissions")
        .eq("app_id", appId)
        .eq("id", access.member.role_id)
        .single();
      role = data;
    }
    const issuedAt = new Date();
    const fingerprint = await bundleFingerprint(
      user.id,
      version.id,
      installationId,
      issuedAt.toISOString(),
    );
    const manifest = buildManifest({
      app,
      version,
      userId: user.id,
      role,
      installationId,
      fingerprint,
      issuedAt,
    });
    const signature = await signWithCloudKey(canonicalJson(manifest));
    const archive = await signedDownloadUrl(version.storage_path, req);

    await audit({
      action: "bundle.generate",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `installation:${installationId}`,
      details: {
        versionId: version.id,
        version: version.version,
        fingerprint,
        roleId: role?.id ?? null,
      },
      req,
    });
    await incrementMetric("bundles.generate");
    return { manifest, signature, archiveUrl: archive.url, archiveUrlExpiresAt: archive.expiresAt };
  }),
);
