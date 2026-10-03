import type { Autosave } from "./useAutosave";

const savedTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Sidebar save indicator: dirty, saving, saved (with time), or error with Retry. */
export function SaveStatus({ autosave, hasPath }: { autosave: Autosave; hasPath: boolean }) {
  const { view, controller } = autosave;
  return (
    <div
      className={`sidebar-bottom save-status save-status-${view.status}`}
      role="group"
      aria-label="Save status"
      aria-live="polite"
    >
      <span className="status-dot" />
      {view.status === "saving" && <span>Saving…</span>}
      {view.status === "dirty" && (
        <span>
          Unsaved changes
          {!hasPath && <small>Save once to turn on autosave</small>}
        </span>
      )}
      {view.status === "clean" && <span>All changes saved</span>}
      {view.status === "saved" && view.lastSavedAt && (
        <span>
          Saved at <time dateTime={view.lastSavedAt}>{savedTime(view.lastSavedAt)}</time>
        </span>
      )}
      {view.status === "error" && (
        <span>
          Save failed: {view.error?.message ?? "unknown error"}
          {view.eligible ? (
            <button
              className="text-button"
              onClick={() => {
                controller.flush().catch(() => undefined);
              }}
            >
              Retry save
            </button>
          ) : (
            <small>Use Save As or reopen the file to continue.</small>
          )}
        </span>
      )}
    </div>
  );
}
