import { formatBytes } from "./transfer";
import type { TransferProgress } from "./types";

/** Accessible progress bar for an archive transfer. */
export function TransferBar({
  progress,
  label,
}: {
  progress: TransferProgress | null;
  label: string;
}) {
  if (!progress) return null;
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="cloud-progress">
      <progress
        aria-label={label}
        max={progress.total || 1}
        value={progress.done}
        aria-valuetext={`${percent}%`}
      />
      <small>
        {formatBytes(progress.done)} of {formatBytes(progress.total)}
      </small>
    </div>
  );
}
