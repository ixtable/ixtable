import type { GridTrack, TrackKind } from "../grid/types";

/** A track's size from typed text, or the problem with it. */
export function parseTrackSize(kind: TrackKind, text: string): number | string {
  const parsed = Number(text);
  if (text.trim() === "" || !Number.isFinite(parsed) || parsed <= 0)
    return "Size must be a positive number.";
  return kind === "fixed" ? Math.max(1, Math.round(parsed)) : parsed;
}

/** A min or max pixel limit from typed text (blank clears it), or the problem with it. */
export function parseTrackLimit(
  track: GridTrack,
  key: "min" | "max",
  text: string,
): number | null | string {
  if (text.trim() === "") return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) return "Enter a whole number of pixels.";
  const value = Math.round(parsed);
  const min = key === "min" ? value : track.min;
  const max = key === "max" ? value : track.max;
  if (min != null && max != null && min > max) return "Minimum cannot exceed maximum.";
  return value;
}
