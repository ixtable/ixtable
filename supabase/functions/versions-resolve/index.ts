// Resolves a diverged archive history (PRD §22.4: explicit overwrite or
// fork; no merge) and withdraws published versions (rollback).
// Developer/Owner only; overwrite and fork need an entitled app.
//
// overwrite: publishes the caller's pending upload as the new head even
//   though it was not based on the current head. `fromVersionId` is the head
//   being overwritten (from the 409 details); if the head moved again →
//   409 VERSION_CONFLICT. Same publish fields and checks as
//   publish-checkpoint. The new version records resolution "overwrite" and
//   parent = fromVersionId. Audits version.overwrite.
// fork: creates a new cloud app in the same organization owned by the caller
//   (roles copied, no members, no subscription) whose first version is either
//   the caller's pending upload (publish fields given) or a copy of the
//   published version `fromVersionId`. Optional `name` and `documentId`
//   (default "<name> (fork)" and "<documentId>:fork:<newAppId>", because one
//   document links to one live app per organization). Audits app.create on
//   the new app and version.fork on both apps.
// withdraw: marks a published version withdrawn (rows stay immutable
//   otherwise). If it was the head, the head moves to the most recently
//   published remaining version (null when none); Runtime installations
//   then sync to that version. Withdrawing the last published version while
//   installations run it needs `confirm: true`, else 422 with
//   details {requiresConfirm:true, installations}. Not entitlement-gated,
//   so a bad release can always be pulled. Audits version.withdraw.
//
// POST {appId, action:"withdraw", versionId, confirm?}
//   → {version, headVersionId, dependentInstallations}
// POST {appId, action:"overwrite", fromVersionId, uploadId, version, releaseNotes,
//       minRuntimeVersion, migrations, security} → {version}
// POST {appId, action:"fork", fromVersionId?, uploadId?, version?, …, name?, documentId?}
//   → {app, version}
import { audit } from "../_shared/audit.ts";
import { ARCHIVE_BUCKET, serviceClient } from "../_shared/db.ts";
import {
  type AppRow,
  loadApp,
  preparePublish,
  readPublishInput,
  requireAppOwner,
  rpc,
  versionPath,
  type VersionRow,
} from "../_shared/distribution.ts";
import { requireEntitlement } from "../_shared/entitlements.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { bool, oneOf, str, uuid } from "../_shared/validate.ts";

type Body = Record<string, unknown>;

async function overwrite(req: Request, body: Body, app: AppRow, userId: string, allowance: number) {
  const fromVersionId = uuid(body, "fromVersionId");
  const input = readPublishInput(body);
  if (app.head_version_id !== fromVersionId)
    throw new HttpError("VERSION_CONFLICT", "The published head has moved again", {
      headVersionId: app.head_version_id,
      expectedHeadVersionId: fromVersionId,
    });
  const prepared = await preparePublish(app, input, userId, { allowance });
  const version = await rpc<VersionRow>("distribution_commit_version", {
    p_app_id: app.id,
    p_upload_id: input.uploadId,
    p_developer_id: userId,
    p_version: input.version,
    p_check_head: true,
    p_expected_head: fromVersionId,
    p_migrations: prepared.migrations,
    p_min_runtime_version: input.minRuntimeVersion,
    p_security: prepared.security,
    p_release_notes: input.releaseNotes,
    p_parent_version_id: fromVersionId,
    p_resolution: "overwrite",
    p_storage_path: null,
    p_datasource_kind: prepared.security.store,
  });
  await audit({
    action: "version.overwrite",
    actorId: userId,
    orgId: app.org_id,
    appId: app.id,
    target: `version:${version.id}`,
    details: { version: version.version, overwrittenVersionId: fromVersionId },
    req,
  });
  await incrementMetric("versions.overwrite");
  return { version };
}

async function fork(req: Request, body: Body, app: AppRow, userId: string, allowance: number) {
  const db = serviceClient();
  const fromVersionId = uuid(body, "fromVersionId", { optional: true }) ?? null;
  const fromUpload = body.uploadId !== undefined && body.uploadId !== null;
  if (!fromUpload && !fromVersionId)
    throw new HttpError("VALIDATION", "uploadId or fromVersionId: one is required", {
      field: "uploadId",
    });
  const name = (str(body, "name", { optional: true, max: 200 }) ?? `${app.name} (fork)`)
    .trim()
    .slice(0, 200);
  const newAppId = crypto.randomUUID();
  const documentId =
    str(body, "documentId", { optional: true, max: 200 }) ??
    `${app.document_id.slice(0, 150)}:fork:${newAppId}`;

  // Validate the source before creating anything.
  let source: VersionRow | null = null;
  let prepared: Awaited<ReturnType<typeof preparePublish>> | null = null;
  let input: ReturnType<typeof readPublishInput> | null = null;
  if (fromUpload) {
    input = readPublishInput(body);
    // Version ordering is per app: the fork starts a new history.
    prepared = await preparePublish({ ...app, head_version_id: null }, input, userId, {
      allowance,
    });
  } else {
    source = (await db.from("app_versions").select("*").eq("id", fromVersionId).maybeSingle())
      .data as VersionRow | null;
    if (!source || source.app_id !== app.id || source.status !== "published")
      throw new HttpError("NOT_FOUND", "Version not found");
  }

  const { data: created, error } = await db
    .from("cloud_apps")
    .insert({
      id: newAppId,
      org_id: app.org_id,
      owner_id: userId,
      name,
      document_id: documentId,
      datasource_kind: app.datasource_kind,
      backups_enabled: app.backups_enabled,
      retention_versions: app.retention_versions,
      retention_days: app.retention_days,
    })
    .select()
    .single();
  if (error?.code === "23505")
    throw new HttpError(
      "VALIDATION",
      "documentId: already linked to a live app in this organization",
      {
        field: "documentId",
      },
    );
  if (error || !created) throw new Error(`create fork: ${error?.message}`);

  try {
    const { data: roles } = await db
      .from("app_roles")
      .select("id, name, permissions")
      .eq("app_id", app.id);
    if (roles && roles.length > 0) {
      const copy = await db
        .from("app_roles")
        .insert(roles.map((role) => ({ ...role, app_id: newAppId })));
      if (copy.error) throw new Error(`copy roles: ${copy.error.message}`);
    }
    const storage = db.storage.from(ARCHIVE_BUCKET);
    let version: VersionRow;
    if (prepared && input) {
      const path = versionPath(newAppId, prepared.upload.id);
      const moved = await storage.move(prepared.upload.storage_path, path);
      if (moved.error) throw new Error(`move archive: ${moved.error.message}`);
      try {
        version = await rpc<VersionRow>("distribution_commit_version", {
          p_app_id: newAppId,
          p_upload_id: prepared.upload.id,
          p_developer_id: userId,
          p_version: input.version,
          p_check_head: true,
          p_expected_head: null,
          p_migrations: prepared.migrations,
          p_min_runtime_version: input.minRuntimeVersion,
          p_security: prepared.security,
          p_release_notes: input.releaseNotes,
          p_parent_version_id: fromVersionId,
          p_resolution: "fork",
          p_storage_path: path,
          p_datasource_kind: prepared.security.store,
        });
      } catch (err) {
        await storage.move(path, prepared.upload.storage_path);
        throw err;
      }
    } else {
      const src = source as VersionRow;
      const id = crypto.randomUUID();
      const path = versionPath(newAppId, id);
      const copied = await storage.copy(src.storage_path, path);
      if (copied.error) throw new Error(`copy archive: ${copied.error.message}`);
      const inserted = await db
        .from("app_versions")
        .insert({
          id,
          app_id: newAppId,
          version: src.version,
          developer_id: userId,
          archive_sha256: src.archive_sha256,
          archive_size: src.archive_size,
          storage_path: path,
          migrations: src.migrations,
          min_runtime_version: src.min_runtime_version,
          security: src.security,
          release_notes: src.release_notes,
          status: "published",
          published_at: new Date().toISOString(),
          parent_version_id: src.id,
          resolution: "fork",
        })
        .select()
        .single();
      if (inserted.error || !inserted.data) {
        await storage.remove([path]);
        throw new Error(`insert fork version: ${inserted.error?.message}`);
      }
      version = inserted.data as VersionRow;
      await db.from("cloud_apps").update({ head_version_id: id }).eq("id", newAppId);
    }

    const { data: app2 } = await db.from("cloud_apps").select("*").eq("id", newAppId).single();
    await audit({
      action: "app.create",
      actorId: userId,
      orgId: app.org_id,
      appId: newAppId,
      target: `app:${newAppId}`,
      details: { name, documentId, forkedFromAppId: app.id, forkedFromVersionId: fromVersionId },
      req,
    });
    for (const appId of [app.id, newAppId]) {
      await audit({
        action: "version.fork",
        actorId: userId,
        orgId: app.org_id,
        appId,
        target: `version:${version.id}`,
        details: {
          sourceAppId: app.id,
          forkAppId: newAppId,
          fromVersionId,
          version: version.version,
          from: fromUpload ? "upload" : "version",
        },
        req,
      });
    }
    await incrementMetric("versions.fork");
    return { app: app2 ?? created, version };
  } catch (err) {
    // Roll back the half-made fork; the source app is untouched.
    await db.from("cloud_apps").delete().eq("id", newAppId);
    throw err;
  }
}

async function withdraw(req: Request, body: Body, app: AppRow, userId: string) {
  const versionId = uuid(body, "versionId");
  const confirm = bool(body, "confirm", { optional: true }) ?? false;
  const result = await rpc<{
    version: VersionRow;
    headVersionId: string | null;
    dependentInstallations: number;
  }>("distribution_withdraw_version", {
    p_app_id: app.id,
    p_version_id: versionId,
    p_confirm: confirm,
  });
  await audit({
    action: "version.withdraw",
    actorId: userId,
    orgId: app.org_id,
    appId: app.id,
    target: `version:${versionId}`,
    details: {
      version: result.version.version,
      previousHeadVersionId: app.head_version_id,
      headVersionId: result.headVersionId,
      dependentInstallations: result.dependentInstallations,
      confirmed: confirm,
    },
    req,
  });
  await incrementMetric("versions.withdraw");
  return result;
}

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const action = oneOf(body, "action", ["overwrite", "fork", "withdraw"] as const);

    await enforceNamedRateLimit("versions-resolve", user.id);
    const app = await loadApp(appId);
    requireAppOwner(app, user.id);
    if (action === "withdraw") return withdraw(req, body, app, user.id);
    const entitlement = await requireEntitlement(appId);
    return action === "overwrite"
      ? overwrite(req, body, app, user.id, entitlement.allowance)
      : fork(req, body, app, user.id, entitlement.allowance);
  }),
);
