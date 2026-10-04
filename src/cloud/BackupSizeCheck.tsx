import { ArchiveSizeDetails } from "../persistence";
import type { ArchiveSizeReport } from "../persistence/types";

/**
 * The archive size report shown before a backup is uploaded (PRD §7.4). An
 * archive over the cloud limit cannot be backed up; the report says what is large.
 */
export function BackupSizeCheck({
  report,
  busy,
  onConfirm,
  onCancel,
}: {
  report: ArchiveSizeReport;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="cloud-dialog" role="dialog" aria-label="Backup size">
      <h3>Back up to ixtable Cloud?</h3>
      <ArchiveSizeDetails report={report} />
      <div className="cloud-actions">
        <button
          type="button"
          className="save"
          disabled={busy || report.overCloudLimit}
          onClick={onConfirm}
        >
          Back up now
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
