import { useEffect, useState } from "react";
import { useDocumentConfig } from "../lib/config-store";
import type { Issue } from "../lib/types";
import { ActionsPanel } from "./ActionsPanel";
import { validateAutomation } from "./api";
import "./automation.css";
import { JobsPanel } from "./JobsPanel";
import { TriggersPanel } from "./TriggersPanel";

export { ActionPicker } from "./ActionPicker";

const TABS = [
  { id: "actions", label: "Actions", Component: ActionsPanel },
  { id: "triggers", label: "Triggers", Component: TriggersPanel },
  { id: "jobs", label: "Jobs", Component: JobsPanel },
] as const;

/** Automation mode (PRD §17): actions, record triggers, and the background job queue. */
export function AutomationMode() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("actions");
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  return (
    <div className="ax-mode">
      <h2 className="ax-title">Automation</h2>
      <div className="ax-tabs" role="tablist" aria-label="Automation">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`ax-tab-${t.id}`}
            aria-selected={t.id === tab}
            aria-controls="ax-panel"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <AutomationIssues />
      <div
        role="tabpanel"
        id="ax-panel"
        aria-labelledby={`ax-tab-${active.id}`}
        className="ax-split-host"
      >
        <active.Component />
      </div>
    </div>
  );
}

/** Validation problems in actions and triggers (including missing tables). */
function AutomationIssues() {
  const { config, settled } = useDocumentConfig();
  const [issues, setIssues] = useState<Issue[]>([]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      settled()
        .then(validateAutomation)
        .then((next) => live && setIssues(next))
        .catch(() => live && setIssues([]));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [config.actions, config.triggers, settled]);
  if (!issues.length) return null;
  return (
    <details className="ax-editor">
      <summary>
        {issues.length} automation problem{issues.length === 1 ? "" : "s"}
      </summary>
      <ul className="ax-issues" aria-label="Automation problems">
        {issues.map((issue, i) => (
          <li key={i} className={issue.severity}>
            {issue.message}
          </li>
        ))}
      </ul>
    </details>
  );
}
