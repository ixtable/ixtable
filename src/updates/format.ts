import type { UpdateProgress } from "./types";

const units = ["B", "KB", "MB", "GB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`;
}

/** Human progress line for the download bar. */
export function describeProgress(progress: UpdateProgress): string {
  if (progress.phase === "installing") return "Verifying signature and installing…";
  if (progress.phase === "installed") return "Installed. Relaunching…";
  if (!progress.total) return `Downloaded ${formatBytes(progress.downloaded)}`;
  const percent = Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
  return `Downloaded ${formatBytes(progress.downloaded)} of ${formatBytes(progress.total)} (${percent}%)`;
}

/** The message shown for an updater failure code. */
export function describeUpdateError(code: string, message: string): string {
  if (code === "UPDATE_SIGNATURE_INVALID")
    return "The downloaded update failed signature verification and was not installed.";
  if (code === "NO_PENDING_UPDATE") return "Check for updates again before installing.";
  return message;
}
