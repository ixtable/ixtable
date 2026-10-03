/** Mirrors `src-tauri/src/updater` (serde camelCase). */
export type UpdateChannel = "stable" | "beta";

export interface UpdateSettings {
  currentVersion: string;
  channel: UpdateChannel;
  autoCheck: boolean;
  endpoint: string;
}

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  channel: UpdateChannel;
  date: string | null;
  notes: string | null;
}

export type UpdatePhase = "idle" | "downloading" | "installing" | "installed" | "failed";

export interface UpdateProgress {
  phase: UpdatePhase;
  downloaded: number;
  total: number | null;
}

export const UPDATE_CHANNELS: readonly { id: UpdateChannel; label: string; hint: string }[] = [
  { id: "stable", label: "Stable", hint: "Releases that passed the full release checklist." },
  { id: "beta", label: "Beta", hint: "Earlier access to new features; may contain bugs." },
];
