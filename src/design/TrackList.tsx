import { Plus, Trash2 } from "lucide-react";
import type { GridTrack, TrackKind } from "../grid/types";

const KINDS: { kind: TrackKind; label: string }[] = [
  { kind: "fr", label: "Share (fr)" },
  { kind: "fixed", label: "Fixed (px)" },
  { kind: "content", label: "Fit content" },
];

/** Blank input clears an optional pixel limit; anything else is a whole non-negative number. */
const optional = (value: string): number | null => {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
};

const defaultValue = (kind: TrackKind): number | null =>
  kind === "fixed" ? 120 : kind === "fr" ? 1 : null;

/** Editor for a list of grid tracks (columns or rows): kind, size, and min/max in pixels. */
export function TrackList({
  name,
  tracks,
  onChange,
  minCount = 0,
}: {
  // Singular noun used in labels, e.g. "Column" or "Row".
  name: string;
  tracks: GridTrack[];
  onChange: (tracks: GridTrack[]) => void;
  minCount?: number;
}) {
  const set = (index: number, patch: Partial<GridTrack>) =>
    onChange(tracks.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  return (
    <div className="fd-tracks" role="group" aria-label={`${name} tracks`}>
      {tracks.map((track, index) => {
        const label = `${name} ${index + 1}`;
        return (
          <div className="fd-track" key={index}>
            <select
              aria-label={`${label} size kind`}
              value={track.kind}
              onChange={(e) => {
                const kind = e.target.value as TrackKind;
                set(index, { kind, value: defaultValue(kind) });
              }}
            >
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            {track.kind !== "content" && (
              <input
                type="number"
                min={0}
                step={track.kind === "fr" ? 0.5 : 1}
                aria-label={`${label} size`}
                value={track.value ?? ""}
                onChange={(e) => {
                  const parsed = Number(e.target.value);
                  const valid = e.target.value !== "" && Number.isFinite(parsed) && parsed >= 0;
                  set(index, {
                    value: !valid ? null : track.kind === "fixed" ? Math.round(parsed) : parsed,
                  });
                }}
              />
            )}
            <input
              type="number"
              min={0}
              placeholder="min px"
              aria-label={`${label} minimum pixels`}
              value={track.min ?? ""}
              onChange={(e) => set(index, { min: optional(e.target.value) })}
            />
            <input
              type="number"
              min={0}
              placeholder="max px"
              aria-label={`${label} maximum pixels`}
              value={track.max ?? ""}
              onChange={(e) => set(index, { max: optional(e.target.value) })}
            />
            <button
              type="button"
              aria-label={`Remove ${label.toLowerCase()}`}
              disabled={tracks.length <= minCount}
              onClick={() => onChange(tracks.filter((_, i) => i !== index))}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        disabled={tracks.length >= 24}
        onClick={() => onChange([...tracks, { kind: "fr", value: 1, min: null, max: null }])}
      >
        <Plus aria-hidden="true" />
        Add {name.toLowerCase()}
      </button>
    </div>
  );
}
