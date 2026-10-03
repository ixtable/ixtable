import React, { useState, type ReactNode } from "react";
import { formatBytes, useCloudApi, type FunctionMap } from "@site/src/lib/cloud";
import { ConfirmDialog, Notice } from "../ui";
import { useAction } from "../useAsync";

type RestoreOut = FunctionMap["restore-url"]["out"];

export const POSTGRES_RESTORE_WARNING =
  "External PostgreSQL records are not restored. The archive restores the app definition and settings only. Records in your PostgreSQL database stay as they are now.";

/**
 * Download a published version or an installation backup for restore. The PostgreSQL
 * limitation is shown before the download link is created (PRD §23).
 */
export default function RestoreDialog({
  appId,
  isPostgres,
  target,
  label,
  onClose,
}: {
  appId: string;
  isPostgres: boolean;
  target: { versionId?: string; backupId?: string } | null;
  label: string;
  onClose: () => void;
}): ReactNode {
  const api = useCloudApi();
  const [result, setResult] = useState<RestoreOut | null>(null);
  const create = useAction(async () => {
    if (!target) return;
    setResult(await api.call("restore-url", { appId, ...target }));
  });
  const close = () => {
    setResult(null);
    create.clearError();
    onClose();
  };
  return (
    <ConfirmDialog
      open={target !== null}
      title={`Download ${label}`}
      confirmLabel={result ? "Done" : "Create download link"}
      pending={create.pending}
      error={create.error}
      onConfirm={() => (result ? close() : create.run())}
      onCancel={close}
    >
      {isPostgres && (
        <Notice tone="warning" title="PostgreSQL app" testId="restore-postgres-warning">
          {POSTGRES_RESTORE_WARNING}
        </Notice>
      )}
      <p>
        Open the downloaded file in the ixtable desktop app to restore it as a new local copy. The
        restore never overwrites an existing installation.
      </p>
      {result && (
        <>
          {result.warning && <Notice tone="warning">{result.warning}</Notice>}
          <p>
            <a href={result.signedUrl} download data-testid="restore-download-link">
              Download archive ({formatBytes(result.size)})
            </a>
          </p>
          <p className="cloud-muted">
            SHA-256 <span className="cloud-code">{result.sha256}</span>. The link expires shortly.
          </p>
        </>
      )}
    </ConfirmDialog>
  );
}
