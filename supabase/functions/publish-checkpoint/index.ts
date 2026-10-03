// Publishes an uploaded archive as an immutable checkpoint and moves the
// app's head to it (PRD §22.2). Publishing is always this explicit call;
// nothing publishes implicitly. Developer/Owner only, entitled app.
//
// Preconditions, in order: the upload is the caller's pending version upload
// for this app; `expectedHeadVersionId` equals the current head (null for the
// first publish), else 409 VERSION_CONFLICT with details.headVersionId (then
// resolve with versions-resolve); the version is strictly greater than the
// head's; the security summary passes (non-TLS needs
// insecureTransportConfirmed, a shared PostgreSQL credential needs
// sharedCredentialAcknowledged, concurrencyPoliciesResolved is required once
// more than one Runtime User can use the app); the stored object exists with
// the declared size. The head check, upload consumption, version insert and
// head move run in one transaction (SQL distribution_commit_version).
// Audits version.publish.
//
// POST {appId, uploadId, version, releaseNotes, minRuntimeVersion, migrations,
//       security, expectedHeadVersionId} → {version}
import { audit } from "../_shared/audit.ts";
import {
  loadApp,
  preparePublish,
  readPublishInput,
  requireAppOwner,
  rpc,
  type VersionRow,
} from "../_shared/distribution.ts";
import { requireEntitlement } from "../_shared/entitlements.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    if (!("expectedHeadVersionId" in body))
      throw new HttpError(
        "VALIDATION",
        "expectedHeadVersionId: is required (null for the first publish)",
        {
          field: "expectedHeadVersionId",
        },
      );
    const expectedHead = uuid(body, "expectedHeadVersionId", { optional: true }) ?? null;
    const input = readPublishInput(body);

    await enforceRateLimit(`publish-checkpoint:${user.id}`, 30, 3600);
    const app = await loadApp(appId);
    requireAppOwner(app, user.id);
    const entitlement = await requireEntitlement(appId);
    if ((app.head_version_id ?? null) !== expectedHead)
      throw new HttpError(
        "VERSION_CONFLICT",
        "The published head has moved since this archive was based on it",
        {
          headVersionId: app.head_version_id,
          expectedHeadVersionId: expectedHead,
        },
      );
    const prepared = await preparePublish(app, input, user.id, {
      allowance: entitlement.allowance,
    });

    const version = await rpc<VersionRow>("distribution_commit_version", {
      p_app_id: appId,
      p_upload_id: input.uploadId,
      p_developer_id: user.id,
      p_version: input.version,
      p_check_head: true,
      p_expected_head: expectedHead,
      p_migrations: prepared.migrations,
      p_min_runtime_version: input.minRuntimeVersion,
      p_security: prepared.security,
      p_release_notes: input.releaseNotes,
      p_parent_version_id: expectedHead,
      p_resolution: null,
      p_storage_path: null,
      p_datasource_kind: prepared.security.store,
    });

    await audit({
      action: "version.publish",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `version:${version.id}`,
      details: {
        version: version.version,
        previousHeadVersionId: expectedHead,
        archiveSha256: version.archive_sha256,
        archiveSize: version.archive_size,
        migrations: prepared.migrations.length,
        tls: prepared.security.tls,
        insecureTransportConfirmed: prepared.security.insecureTransportConfirmed,
        sharedCredentialAcknowledged: prepared.security.sharedCredentialAcknowledged,
      },
      req,
    });
    await incrementMetric("versions.publish");
    return { version };
  }),
);
