// Tells a Runtime installation whether a newer checkpoint is published (PRD
// §22.3) and records what it runs: `installedVersionId` (when it is a version
// of this app) becomes the installation's installed version, which
// retention-sweep never deletes, and last_seen_at is updated. Same access
// rules as bundle-manifest (403 FORBIDDEN / REVOKED); the installation must
// be the caller's (404 when unknown, 403 REVOKED when revoked).
//
// POST {appId, installedVersionId, installationId}
//   → {upToDate, latest:{versionId, version, publishedAt, minRuntimeVersion} | null}
import { serviceClient } from "../_shared/db.ts";
import {
  type InstallationRow,
  latestPublished,
  loadApp,
  requireRuntimeAccess,
} from "../_shared/distribution.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const installationId = uuid(body, "installationId");
    const installedVersionId = uuid(body, "installedVersionId", { optional: true }) ?? null;

    await enforceNamedRateLimit("sync-check", user.id);
    const app = await loadApp(appId);
    await requireRuntimeAccess(app, user.id);
    const db = serviceClient();
    const { data: installation } = await db
      .from("installations")
      .select("*")
      .eq("id", installationId)
      .maybeSingle();
    const inst = installation as InstallationRow | null;
    if (!inst || inst.app_id !== appId || inst.user_id !== user.id)
      throw new HttpError("NOT_FOUND", "Installation not found");
    if (inst.revoked_at) throw new HttpError("REVOKED", "This installation was revoked");

    const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
    if (installedVersionId) {
      const { data: known } = await db
        .from("app_versions")
        .select("id")
        .eq("id", installedVersionId)
        .eq("app_id", appId)
        .maybeSingle();
      if (known) patch.installed_version_id = installedVersionId;
    }
    await db.from("installations").update(patch).eq("id", installationId);

    const latest = await latestPublished(app);
    await incrementMetric("sync.check");
    return {
      upToDate: !latest || latest.id === installedVersionId,
      latest: latest
        ? {
            versionId: latest.id,
            version: latest.version,
            publishedAt: latest.published_at,
            minRuntimeVersion: latest.min_runtime_version,
          }
        : null,
    };
  }),
);
