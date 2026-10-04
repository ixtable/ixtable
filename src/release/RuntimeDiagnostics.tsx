import { useId, useState } from "react";
import { JobsPanel } from "../automation/JobsPanel";
import "../automation/automation.css";
import { LogsTab } from "../persistence/LogsTab";

/**
 * Runtime-only windows have no Studio modes, so background jobs (status, attempts,
 * retry, cancel) and the local log are reached from the runtime sidebar instead.
 * Neither changes the application definition.
 */
export function RuntimeDiagnostics() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"jobs" | "logs">("jobs");
  const titleId = useId();
  return (
    <>
      <button type="button" className="runtime-bar-action" onClick={() => setOpen(true)}>
        Diagnostics…
      </button>
      {open && (
        <div
          className="bundle-password runtime-diagnostics"
          role="dialog"
          aria-labelledby={titleId}
        >
          <h2 id={titleId}>Diagnostics</h2>
          <div role="tablist" aria-label="Diagnostics">
            {(["jobs", "logs"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {id === "jobs" ? "Background jobs" : "Logs"}
              </button>
            ))}
          </div>
          <div role="tabpanel">{tab === "jobs" ? <JobsPanel /> : <LogsTab />}</div>
          <div className="settings-actions">
            <button type="button" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
