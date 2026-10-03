import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { saveDocument } from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import { documentState } from "../release/api";
import { useShell } from "../shell/context";
import { publishPreflight, uploadArchive } from "./api";
import { invokeFunction, runtimeCapacity, requireSession } from "./client";
import { CloudError } from "./errors";
import { ActionStatus } from "./StudioPanels";
import { useCloudAction } from "./useCloudAction";
import { TransferBar } from "./TransferBar";
import { formatBytes, useTransfer } from "./transfer";
import type { CloudApp, Preflight, UploadResult } from "./types";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type Published = { version: { id: string; version: string } };
type Conflict = {
  upload: UploadResult;
  body: Record<string, unknown>;
  headVersionId: string | null;
};

/**
 * Publish checkpoint (PRD §22.2): preflight (size, validation, concurrency,
 * TLS, credentials), then save → upload → `publish-checkpoint`. Never runs
 * from autosave: only the button publishes.
 */
export function PublishPanel({
  app,
  onPublished,
}: {
  app: CloudApp | null;
  onPublished: () => void;
}) {
  const { config, update, settled } = useDocumentConfig();
  const shell = useShell();
  const link = config.cloud;
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [version, setVersion] = useState(config.release?.version || "1.0.0");
  const [notes, setNotes] = useState(config.release?.notes ?? "");
  const [minRuntime, setMinRuntime] = useState(config.release?.minRuntimeVersion ?? "");
  const [ackShared, setAckShared] = useState(false);
  const [ackInsecure, setAckInsecure] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const { busy, error, notice, run, setError } = useCloudAction();
  const { progress, track } = useTransfer();
  const titleId = useId();
  const appId = link?.appId ?? "";

  const check = useCallback(async () => {
    const users = await runtimeCapacity(appId).catch(() => 0);
    setPreflight(await publishPreflight(users));
  }, [appId]);
  useEffect(() => {
    check().catch(() => setPreflight(null));
  }, [check]);

  if (!link) return null;
  const security = preflight?.security;
  const needsShared = !!security?.sharedCredentialWarning;
  const needsInsecure = !!security?.insecureOverrideConfirmed;
  const versionError = SEMVER.test(version.trim()) ? "" : "Enter a semantic version such as 1.2.0.";
  const minError =
    !minRuntime.trim() || SEMVER.test(minRuntime.trim())
      ? ""
      : "Enter a semantic version or leave blank.";
  const blocked =
    !preflight ||
    preflight.blockers.length > 0 ||
    !!versionError ||
    !!minError ||
    (needsShared && !ackShared) ||
    (needsInsecure && !ackInsecure);

  const securityBody = () => ({
    ...security,
    insecureTransportConfirmed: needsInsecure && ackInsecure,
    insecureTransportConfirmedAt: security?.insecureOverrideConfirmedAt ?? null,
    sharedCredentialAcknowledged: needsShared && ackShared,
    concurrencyPoliciesResolved: !!security?.entityPoliciesResolved,
    unresolvedEntities: preflight?.unresolvedEntities ?? [],
  });

  const finish = async (published: Published) => {
    await update(
      (draft) => ({ ...draft, cloud: { ...link, headVersionId: published.version.id } }),
      "Record published version",
    );
    await settled();
    // The publish base is part of the document: save it so the next publish detects divergence.
    shell.applySession(await saveDocument());
    onPublished();
    await check().catch(() => undefined);
    return `Published version ${published.version.version}. Runtime users receive it on their next sync.`;
  };

  const publish = (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    run(async () => {
      const release = {
        version: version.trim(),
        notes,
        minRuntimeVersion: minRuntime.trim() || null,
      };
      await update((draft) => ({ ...draft, release }), "Edit release");
      await settled();
      if (!(await documentState()).path) await shell.save();
      let state = await documentState();
      if (state.dirty) {
        state = await saveDocument();
        shell.applySession(state);
      }
      if (!state.path || state.dirty)
        throw new CloudError("SAVE_REQUIRED", "Save the document before publishing.");
      const session = await requireSession();
      const upload = await track((id) => uploadArchive(session.access_token, appId, "version", id));
      const body = {
        appId,
        uploadId: upload.uploadId,
        version: release.version,
        releaseNotes: notes,
        minRuntimeVersion: release.minRuntimeVersion ?? "0.0.0",
        migrations: preflight?.migrations ?? [],
        security: securityBody(),
        expectedHeadVersionId: link.headVersionId ?? null,
      };
      try {
        return await finish(await invokeFunction<Published>("publish-checkpoint", body));
      } catch (reason) {
        if (reason instanceof CloudError && reason.code === "VERSION_CONFLICT") {
          const head =
            (reason.details?.headVersionId as string | undefined) ?? app?.headVersionId ?? null;
          setConflict({ upload, body, headVersionId: head });
        }
        throw reason;
      }
    }).catch(() => undefined);
  };

  const resolve = (action: "overwrite" | "fork") =>
    run(async () => {
      if (!conflict) return;
      const reply = await invokeFunction<
        Partial<Published> & { app?: { id: string; name?: string } }
      >("versions-resolve", { ...conflict.body, action, fromVersionId: conflict.headVersionId });
      setConflict(null);
      if (action === "fork" && reply.app) {
        await update(
          (draft) => ({
            ...draft,
            cloud: {
              appId: reply.app!.id,
              orgId: link.orgId,
              headVersionId: reply.version?.id ?? null,
            },
          }),
          "Link forked cloud application",
        );
        await settled();
        shell.applySession(await saveDocument());
        onPublished();
        return `Forked into a new cloud application${reply.app.name ? ` (${reply.app.name})` : ""}.`;
      }
      if (reply.version) return finish(reply as Published);
      return "Resolved.";
    });

  return (
    <section className="cloud-card" aria-labelledby={titleId}>
      <h2 id={titleId}>Publish checkpoint</h2>
      <p className="cloud-muted">
        Publishing uploads the saved archive as an immutable version. Autosave never publishes.
      </p>
      {preflight ? (
        <PreflightSummary preflight={preflight} />
      ) : (
        <p className="cloud-muted" role="status">
          Checking the application…
        </p>
      )}
      <form className="cloud-form" onSubmit={publish}>
        <label>
          Version
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            aria-invalid={!!versionError}
          />
          {versionError && <small className="field-error">{versionError}</small>}
        </label>
        <label>
          Minimum Runtime version
          <input
            value={minRuntime}
            onChange={(e) => setMinRuntime(e.target.value)}
            placeholder="optional"
          />
          {minError && <small className="field-error">{minError}</small>}
        </label>
        <label className="wide">
          Release notes
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {needsShared && (
          <label className="checkbox wide">
            <input
              type="checkbox"
              checked={ackShared}
              onChange={(e) => setAckShared(e.target.checked)}
            />
            I understand every runtime user receives the same database credential
          </label>
        )}
        {needsInsecure && (
          <label className="checkbox wide">
            <input
              type="checkbox"
              checked={ackInsecure}
              onChange={(e) => setAckInsecure(e.target.checked)}
            />
            I accept publishing with a PostgreSQL connection that may not use TLS
          </label>
        )}
        <div className="cloud-actions wide">
          <button type="submit" className="save" disabled={busy || blocked}>
            Publish checkpoint
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              check().catch(() => undefined);
            }}
          >
            Check again
          </button>
        </div>
      </form>
      <TransferBar progress={progress} label="Upload progress" />
      {conflict && (
        <div className="cloud-dialog" role="dialog" aria-label="Version conflict">
          <h3>The published history moved on</h3>
          <p>
            A checkpoint was published after the version this document is based on. Overwrite
            publishes this document as the newest version anyway. Fork creates a separate cloud
            application from this document. Nothing is merged automatically.
          </p>
          <div className="cloud-actions">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => resolve("overwrite")}
            >
              Overwrite
            </button>
            <button type="button" disabled={busy} onClick={() => resolve("fork")}>
              Fork
            </button>
            <button type="button" disabled={busy} onClick={() => setConflict(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <ActionStatus error={error} notice={notice} />
    </section>
  );
}

function PreflightSummary({ preflight }: { preflight: Preflight }) {
  const { size, security } = preflight;
  return (
    <div className="cloud-preflight">
      <p>
        Archive size <b>{formatBytes(size.totalBytes)}</b> of {formatBytes(size.cloudLimitBytes)}
        {size.measured === "snapshot" && " (unsaved changes included)"}
      </p>
      {size.largest.length > 0 && (
        <details>
          <summary>Largest entries</summary>
          <ul>
            {size.largest.slice(0, 5).map((entry) => (
              <li key={`${entry.section}:${entry.id}`}>
                {entry.name} ({entry.section}): {formatBytes(entry.bytes)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {preflight.blockers.length > 0 && (
        <div className="cloud-blockers" role="alert" aria-label="Publishing is blocked">
          <b>Publishing is blocked</b>
          <ul>
            {preflight.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      )}
      {preflight.warnings.length > 0 && (
        <ul className="cloud-warnings" aria-label="Publishing warnings">
          {preflight.warnings.map((warning) => (
            <li key={warning} className={warning.startsWith("SEVERE") ? "severe" : ""}>
              {warning}
            </li>
          ))}
        </ul>
      )}
      <dl className="cloud-security" aria-label="Security summary">
        <dt>Record store</dt>
        <dd>{security.store === "postgres" ? "PostgreSQL" : "Embedded SQLite"}</dd>
        {security.store === "postgres" && (
          <>
            <dt>Credentials</dt>
            <dd>{security.credentialMode === "perUser" ? "Per user" : "Shared"}</dd>
            <dt>TLS</dt>
            <dd>
              {security.tls
                ? `Required (${security.sslmode})`
                : `Not required (${security.sslmode})${security.insecureOverrideConfirmed ? ", override confirmed" : ""}`}
            </dd>
          </>
        )}
        <dt>Concurrency policies</dt>
        <dd>
          {security.entityPoliciesResolved ? "Set for every entity" : "Missing for some entities"}
        </dd>
        <dt>Migrations</dt>
        <dd>{preflight.migrations.length}</dd>
      </dl>
    </div>
  );
}
