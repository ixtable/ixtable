import { useEffect, useId, useState } from "react";
import { saveDocument } from "../lib/api";
import { documentState } from "../release/api";
import { useShell } from "../shell/context";
import { restoreCopy, uploadArchive } from "./api";
import { invokeFunction, listVersions, requireSession } from "./client";
import { CloudError } from "./errors";
import { requestOpenSession } from "./session";
import { ActionStatus } from "./StudioPanels";
import { useCloudAction } from "./useCloudAction";
import { TransferBar } from "./TransferBar";
import { formatBytes, useTransfer } from "./transfer";
import type { AppVersion, CloudApp, RestoreTarget } from "./types";

type PendingRestore = { version: AppVersion; target: RestoreTarget };

/** Version history (RLS-scoped), restore to a new local copy, and developer backups. */
export function VersionsPanel({ app, revision }: { app: CloudApp | null; revision: number }) {
  const shell = useShell();
  const [versions, setVersions] = useState<AppVersion[] | null>(null);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const { busy, error, notice, run } = useCloudAction();
  const { progress, track } = useTransfer();
  const titleId = useId();
  const appId = app?.id ?? "";

  useEffect(() => {
    if (!appId) return;
    listVersions(appId)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [appId, revision]);

  const restore = async ({ version, target }: PendingRestore) => {
    const state = await documentState();
    if (
      state.dirty &&
      !window.confirm(`Discard unsaved changes in ${state.name} and open the restored copy?`)
    )
      return;
    setPending(null);
    const opened = await track((id) =>
      restoreCopy(target.signedUrl, target.sha256, target.size, version.id, id),
    );
    requestOpenSession(opened);
  };
  const prepareRestore = (version: AppVersion) =>
    run(async () => {
      const target = await invokeFunction("restore-url", {
        appId,
        versionId: version.id,
      });
      // PostgreSQL records live outside the archive: say so before anything changes.
      if (target.isPostgres) {
        setPending({ version, target });
        return;
      }
      await restore({ version, target });
    });
  const backup = () =>
    run(async () => {
      if (!(await documentState()).path) await shell.save();
      let state = await documentState();
      if (state.dirty) {
        state = await saveDocument();
        shell.applySession(state);
      }
      if (!state.path)
        throw new CloudError("SAVE_REQUIRED", "Save the document before backing it up.");
      const session = await requireSession();
      const upload = await track((id) => uploadArchive(session.access_token, appId, "backup", id));
      await invokeFunction("backup-commit", {
        appId,
        uploadId: upload.uploadId,
        installationId: upload.installationId,
      });
      return `Backed up ${formatBytes(upload.size)} to ixtable Cloud.`;
    });

  if (!app) return null;
  return (
    <section className="cloud-card" aria-labelledby={titleId}>
      <h2 id={titleId}>Published versions</h2>
      {versions === null ? (
        <p className="cloud-muted" role="status">
          Loading versions…
        </p>
      ) : versions.length === 0 ? (
        <p className="cloud-muted">Nothing has been published yet.</p>
      ) : (
        <ul className="cloud-versions" aria-label="Version history">
          {versions.map((version) => (
            <li key={version.id}>
              <span>
                <b>{version.version}</b> · {version.status}
                {version.resolution ? ` · ${version.resolution}` : ""} ·{" "}
                <time dateTime={version.createdAt}>
                  {new Date(version.createdAt).toLocaleString()}
                </time>{" "}
                · {formatBytes(version.archiveSize)}
                {version.releaseNotes && <small>{version.releaseNotes}</small>}
              </span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Restore ${version.version} to a new local copy`}
                onClick={() => prepareRestore(version)}
              >
                Restore to new local copy
              </button>
            </li>
          ))}
        </ul>
      )}
      {pending && (
        <div className="cloud-dialog" role="dialog" aria-label="Restore warning">
          <h3>PostgreSQL records are not restored</h3>
          <p>
            {pending.target.warning ??
              "This application keeps its records in an external PostgreSQL database. Restoring the archive brings back the definition and assets only; the database is not changed."}
          </p>
          <div className="cloud-actions">
            <button
              type="button"
              className="save"
              disabled={busy}
              onClick={() => run(() => restore(pending))}
            >
              Restore definition only
            </button>
            <button type="button" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {app.backupsEnabled && (
        <div className="cloud-actions">
          <button type="button" disabled={busy} onClick={backup}>
            Back up to cloud
          </button>
        </div>
      )}
      <TransferBar progress={progress} label="Transfer progress" />
      <ActionStatus error={error} notice={notice} />
    </section>
  );
}
