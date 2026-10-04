import { useCallback, useEffect, useState } from "react";
import { archiveSizeReport } from "../persistence/api";
import type { ArchiveSizeReport } from "../persistence/types";
import { restoreCopy, uploadArchive } from "./api";
import { BackupSizeCheck } from "./BackupSizeCheck";
import { invokeFunction, listInstallationBackups, requireSession } from "./client";
import { CloudErrorNotice } from "./CloudErrorNotice";
import { requestOpenSession } from "./session";
import { TransferBar } from "./TransferBar";
import { formatBytes, useTransfer } from "./transfer";
import type { InstallationBackup, RestoreTarget } from "./types";
import { useCloudAction } from "./useCloudAction";

type PendingRestore = { backup: InstallationBackup; target: RestoreTarget };

/** Same text as Studio's version restore when the server sends none. */
const POSTGRES_FALLBACK =
  "This application keeps its records in an external PostgreSQL database. Restoring the archive brings back the definition and assets only; the database is not changed.";

/**
 * Runtime installation backups (PRD §23): size report before upload (§7.4),
 * this installation's backups, and restore to a new local copy via
 * `restore-url` with `backupId`. The installation itself is never changed.
 */
export function InstallationBackups({
  appId,
  installationId,
}: {
  appId: string;
  installationId: string;
}) {
  const [backups, setBackups] = useState<InstallationBackup[] | null>(null);
  const [sizeCheck, setSizeCheck] = useState<ArchiveSizeReport | null>(null);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const { busy, error, notice, run } = useCloudAction();
  const { progress, track } = useTransfer();

  const load = useCallback(async () => {
    setBackups(await listInstallationBackups(appId, installationId));
  }, [appId, installationId]);
  useEffect(() => {
    load().catch(() => setBackups([]));
  }, [load]);

  const checkSize = () =>
    run(async () => {
      setPending(null);
      setSizeCheck(await archiveSizeReport());
    });
  const backup = () =>
    run(async () => {
      setSizeCheck(null);
      const session = await requireSession();
      const upload = await track((id) => uploadArchive(session.access_token, appId, "backup", id));
      await invokeFunction("backup-commit", {
        appId,
        uploadId: upload.uploadId,
        installationId: upload.installationId ?? installationId,
      });
      await load().catch(() => undefined);
      return `Backed up ${formatBytes(upload.size)} of this installation.`;
    });
  const prepareRestore = (backup: InstallationBackup) =>
    run(async () => {
      setSizeCheck(null);
      const target = await invokeFunction("restore-url", { appId, backupId: backup.id });
      setPending({ backup, target });
    });
  const restore = ({ target }: PendingRestore) =>
    run(async () => {
      setPending(null);
      const opened = await track((id) =>
        restoreCopy(target.signedUrl, target.sha256, target.size, null, id),
      );
      requestOpenSession(opened);
    });

  const when = (backup: InstallationBackup) => new Date(backup.createdAt).toLocaleString();
  return (
    <div className="cloud-backups">
      <button type="button" className="runtime-bar-action" disabled={busy} onClick={checkSize}>
        Back up installation
      </button>
      {sizeCheck && (
        <BackupSizeCheck
          report={sizeCheck}
          busy={busy}
          onConfirm={backup}
          onCancel={() => setSizeCheck(null)}
        />
      )}
      {backups && backups.length > 0 && (
        <ul className="cloud-versions" aria-label="Installation backups">
          {backups.map((item) => (
            <li key={item.id}>
              <span>
                <time dateTime={item.createdAt}>{when(item)}</time> ·{" "}
                {formatBytes(item.archiveSize)}
              </span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Restore backup from ${when(item)} to a new local copy`}
                onClick={() => prepareRestore(item)}
              >
                Restore…
              </button>
            </li>
          ))}
        </ul>
      )}
      {pending && (
        <div className="cloud-dialog" role="dialog" aria-label="Restore backup">
          <h3>Restore the backup from {when(pending.backup)}?</h3>
          <p>
            It opens as a new local copy in this window. This installation and its records are not
            changed.
          </p>
          {pending.target.isPostgres && (
            <p role="note">
              <b>PostgreSQL records are not restored. </b>
              {pending.target.warning ?? POSTGRES_FALLBACK}
            </p>
          )}
          <div className="cloud-actions">
            <button type="button" className="save" disabled={busy} onClick={() => restore(pending)}>
              {pending.target.isPostgres ? "Restore definition only" : "Restore to new local copy"}
            </button>
            <button type="button" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <TransferBar progress={progress} label="Backup transfer progress" />
      {notice && <p role="status">{notice}</p>}
      {error && <CloudErrorNotice error={error} />}
    </div>
  );
}
