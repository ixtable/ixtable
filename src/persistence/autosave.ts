import { asTauriError, type TauriError } from "../lib/api";
import type { SessionState } from "../lib/types";

/** Visible save state (PRD §7.2): dirty, saving, saved (with time), or error (with retry). */
export type SaveStatus = "clean" | "dirty" | "saving" | "saved" | "error";

export interface AutosaveView {
  status: SaveStatus;
  // Autosave runs only for titled, unconflicted, editable documents.
  eligible: boolean;
  lastSavedAt: string | null;
  error: TauriError | null;
}

export interface AutosaveOptions {
  save: () => Promise<SessionState>;
  // Receives the SessionState each autosave returns.
  onState?: (state: SessionState) => void;
  onChange?: (view: AutosaveView) => void;
  // Quiet period after the last change before saving.
  debounceMs?: number;
  // Longest a change may wait while edits keep arriving.
  maxWaitMs?: number;
}

export const AUTOSAVE_DEBOUNCE_MS = 1500;
export const AUTOSAVE_MAX_WAIT_MS = 10_000;

const isEligible = (state: SessionState) => !!state.path && !state.conflict && !state.runtimeOnly;

/**
 * Debounced autosave: each change restarts a `debounceMs` timer, and a `maxWaitMs`
 * timer started by the first unsaved change caps the delay. One save runs at a
 * time; changes made during a save schedule another one.
 */
export class AutosaveController {
  private view: AutosaveView = { status: "clean", eligible: false, lastSavedAt: null, error: null };
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private maxWait: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<SessionState | null> | null = null;
  private changedDuringSave = false;
  private disposed = false;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly options: AutosaveOptions) {
    this.debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? AUTOSAVE_MAX_WAIT_MS;
  }

  get state(): AutosaveView {
    return this.view;
  }

  private set(patch: Partial<AutosaveView>) {
    this.view = { ...this.view, ...patch };
    this.options.onChange?.(this.view);
  }

  // Adopts a backend SessionState (from any command). A dirty state counts as a change.
  sync(state: SessionState) {
    const eligible = isEligible(state);
    const lastSavedAt = state.lastSavedAt ?? this.view.lastSavedAt;
    if (state.dirty) {
      this.set({ eligible, lastSavedAt });
      this.touch();
      return;
    }
    if (this.inFlight) {
      this.set({ eligible, lastSavedAt });
      return;
    }
    this.clearTimers();
    const error = state.lastError ?? null;
    this.set({
      eligible,
      lastSavedAt,
      error,
      status: error ? "error" : state.lastSavedAt ? "saved" : "clean",
    });
  }

  // Records a change: shows "dirty" and (re)schedules a save when eligible.
  touch() {
    if (this.disposed) return;
    if (this.inFlight) {
      this.changedDuringSave = true;
      return;
    }
    if (this.view.status !== "error") this.set({ status: "dirty" });
    if (!this.view.eligible) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.fire(), this.debounceMs);
    this.maxWait ??= setTimeout(() => this.fire(), this.maxWaitMs);
  }

  private fire() {
    this.flush().catch(() => undefined);
  }

  private clearTimers() {
    if (this.debounce) clearTimeout(this.debounce);
    if (this.maxWait) clearTimeout(this.maxWait);
    this.debounce = null;
    this.maxWait = null;
  }

  // Saves now (Retry, or before closing). Resolves with the saved state, or null on failure.
  flush(): Promise<SessionState | null> {
    this.clearTimers();
    if (this.inFlight) return this.inFlight;
    if (this.disposed || !this.view.eligible) return Promise.resolve(null);
    this.changedDuringSave = false;
    this.set({ status: "saving" });
    this.inFlight = this.options
      .save()
      .then((state) => {
        this.inFlight = null;
        if (this.disposed) return state;
        const failed = state.lastError ?? null;
        this.set({
          eligible: isEligible(state),
          lastSavedAt: state.lastSavedAt ?? this.view.lastSavedAt,
          error: state.dirty ? failed : null,
          status: state.dirty
            ? failed
              ? "error"
              : "dirty"
            : state.lastSavedAt
              ? "saved"
              : "clean",
        });
        this.options.onState?.(state);
        if (state.dirty || this.changedDuringSave) this.touch();
        return state;
      })
      .catch((reason: unknown) => {
        this.inFlight = null;
        if (!this.disposed) this.set({ status: "error", error: asTauriError(reason) });
        return null;
      });
    return this.inFlight;
  }

  // Re-enables a disposed controller (React StrictMode re-runs effects).
  resume() {
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
    this.clearTimers();
  }
}
