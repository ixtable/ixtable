import { Plus, Trash2 } from "lucide-react";
import type { GridTrack, TrackKind } from "../grid/types";
import { DraftInput } from "./DraftInput";
import { parseTrackLimit, parseTrackSize } from "./trackInput";

const KINDS: { kind: TrackKind; label: string }[] = [
  { kind: "fr", label: "Share (fr)" },
  { kind: "fixed", label: "Fixed (px)" },
  { kind: "content", label: "Fit content" },
];

const defaultValue = (kind: TrackKind): number | null =>
  kind === "fixed" ? 120 : kind === "fr" ? 1 : null;

/**
 * Editor for a list of grid tracks (columns or rows): kind, size, and min/max in pixels.
 * Numbers are applied on blur or Enter only when valid, so a cleared size or a minimum above
 * the maximum is shown here instead of being saved.
 */
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
  const commit = (index: number, key: "value" | "min" | "max", parsed: number | null | string) => {
    if (typeof parsed === "string") return parsed;
    set(index, { [key]: parsed });
    return "";
  };
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
              <DraftInput
                type="number"
                min={0}
                step={track.kind === "fr" ? 0.5 : 1}
                aria-label={`${label} size`}
                value={String(track.value ?? "")}
                onCommit={(text) => commit(index, "value", parseTrackSize(track.kind, text))}
              />
            )}
            <DraftInput
              type="number"
              min={0}
              placeholder="min px"
              aria-label={`${label} minimum pixels`}
              value={String(track.min ?? "")}
              onCommit={(text) => commit(index, "min", parseTrackLimit(track, "min", text))}
            />
            <DraftInput
              type="number"
              min={0}
              placeholder="max px"
              aria-label={`${label} maximum pixels`}
              value={String(track.max ?? "")}
              onCommit={(text) => commit(index, "max", parseTrackLimit(track, "max", text))}
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
