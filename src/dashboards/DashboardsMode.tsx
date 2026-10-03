/** Dashboards mode (PRD §16): dashboard list, designer on the shared grid, and live view. */
import { Copy, LayoutDashboard, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useDocumentConfig } from "../lib/config-store";
import { DashboardEditor } from "./DashboardEditor";
import { DashboardView } from "./DashboardView";
import { duplicateDashboard, newDashboard } from "./model";
import type { Dashboard } from "./types";
import "../design/design.css";
import "./dashboards.css";

const uniqueName = (base: string, taken: string[]) => {
  let n = 1;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
};

export function DashboardsMode() {
  const { config, update, reload } = useDocumentConfig();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"design" | "view">("design");
  const [synced, setSynced] = useState(false);
  const dashboards = config.dashboards ?? [];
  const dashboard = dashboards.find((d) => d.id === selectedId) ?? dashboards[0];

  // Pick up definitions changed outside the store (queries saved through commands).
  useEffect(() => {
    reload()
      .catch(() => undefined)
      .finally(() => setSynced(true));
  }, [reload]);

  const edit = useCallback(
    (fn: (d: Dashboard) => Dashboard, label = "Edit dashboard") => {
      if (!dashboard) return;
      const id = dashboard.id;
      update(
        (draft) => ({
          ...draft,
          dashboards: draft.dashboards.map((d) => (d.id === id ? fn(d) : d)),
        }),
        label,
      ).catch(() => undefined);
    },
    [dashboard, update],
  );

  const create = () => {
    const next = newDashboard(
      uniqueName(
        "Dashboard",
        dashboards.map((d) => d.name),
      ),
    );
    setSelectedId(next.id);
    setTab("design");
    update(
      (draft) => ({ ...draft, dashboards: [...(draft.dashboards ?? []), next] }),
      "New dashboard",
    ).catch(() => undefined);
  };
  const duplicate = () => {
    if (!dashboard) return;
    const copy = duplicateDashboard(dashboard, `${dashboard.name} copy`);
    setSelectedId(copy.id);
    update(
      (draft) => ({ ...draft, dashboards: [...draft.dashboards, copy] }),
      "Duplicate dashboard",
    ).catch(() => undefined);
  };
  const remove = () => {
    if (!dashboard) return;
    const id = dashboard.id;
    setSelectedId(null);
    update(
      (draft) => ({ ...draft, dashboards: draft.dashboards.filter((d) => d.id !== id) }),
      "Delete dashboard",
    ).catch(() => undefined);
  };

  return (
    <>
      <header className="titlebar">
        <div>
          <p>PROJECT / DASHBOARDS</p>
          <h1>{dashboard ? dashboard.name : "Dashboards"}</h1>
        </div>
      </header>
      <section className="dash-mode" aria-label="Dashboards">
        <nav className="dash-list" aria-label="Dashboard list">
          <small>DASHBOARDS</small>
          <button type="button" disabled={!synced} onClick={create}>
            <Plus aria-hidden="true" /> New dashboard
          </button>
          <ul>
            {dashboards.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  aria-current={d.id === dashboard?.id}
                  onClick={() => setSelectedId(d.id)}
                >
                  <LayoutDashboard aria-hidden="true" /> {d.name || "Untitled dashboard"}
                </button>
              </li>
            ))}
          </ul>
          {!dashboards.length && <p className="fd-hint">No dashboards yet.</p>}
        </nav>
        {!synced ? (
          <div className="dash-muted" role="status">
            Loading dashboards…
          </div>
        ) : dashboard ? (
          <div className="dash-editor">
            <div className="dash-editor-toolbar">
              <label>
                Dashboard name
                <input
                  value={dashboard.name}
                  onChange={(e) =>
                    edit((d) => ({ ...d, name: e.target.value }), "Rename dashboard")
                  }
                />
              </label>
              <button type="button" onClick={duplicate}>
                <Copy aria-hidden="true" /> Duplicate dashboard
              </button>
              <button type="button" onClick={remove}>
                <Trash2 aria-hidden="true" /> Delete dashboard
              </button>
              <div role="tablist" aria-label="Dashboard view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "design"}
                  onClick={() => setTab("design")}
                >
                  Design
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "view"}
                  onClick={() => setTab("view")}
                >
                  View
                </button>
              </div>
            </div>
            {tab === "design" ? (
              <DashboardEditor key={dashboard.id} dashboard={dashboard} edit={edit} />
            ) : (
              <DashboardView dashboardId={dashboard.id} />
            )}
          </div>
        ) : (
          <div className="dash-muted">Create a dashboard to start designing.</div>
        )}
      </section>
    </>
  );
}
