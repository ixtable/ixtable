import { useEffect } from "react";
import { useDocumentConfig } from "../lib/config-store";
import { newId } from "../lib/utils";
import { useShell } from "../shell/context";
import type { EntitySettings } from "./types";
import "./schema.css";

const POLICIES = [
  { value: "optimistic", label: "Optimistic: reject stale edits" },
  { value: "lastWriteWins", label: "Last write wins" },
  { value: "customAction", label: "Custom transactional action" },
];

/** Settings › Entities: the record-conflict policy per table (PRD §19). */
export function EntitiesTab() {
  const { config, update, reload } = useDocumentConfig();
  const { objects } = useShell();
  useEffect(() => {
    reload().catch(() => undefined);
  }, [reload]);
  const tables = objects
    .filter((o) => o.objectType === "table" && !o.name.startsWith("_ixtable_"))
    .map((o) => o.name);
  const orphans = config.entities.filter((e) => !tables.includes(e.table));
  const entityFor = (table: string) => config.entities.find((e) => e.table === table);
  const save = (table: string, patch: Partial<EntitySettings>) =>
    update((draft) => {
      const existing = draft.entities.find((e) => e.table === table);
      const next: EntitySettings = {
        id: existing?.id ?? newId(),
        table,
        concurrency: "optimistic",
        ...existing,
        ...patch,
      };
      return {
        ...draft,
        entities: existing
          ? draft.entities.map((e) => (e.table === table ? next : e))
          : [...draft.entities, next],
      };
    }, `Concurrency policy for ${table}`);
  return (
    <div className="settings-panel">
      <h2>Entities</h2>
      <p>
        Choose how each table resolves conflicting edits. Optimistic entities compare the values a
        user started from and reject the save if someone else changed the record first.
      </p>
      {!tables.length && <p>No tables yet.</p>}
      {!!tables.length && (
        <table aria-label="Entity concurrency policies">
          <thead>
            <tr>
              <th>Table</th>
              <th>Concurrency policy</th>
              <th>Action</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((table) => {
              const entity = entityFor(table);
              const policy = entity?.concurrency ?? "";
              const missingAction =
                policy === "customAction" && !config.actions.some((a) => a.id === entity?.actionId);
              return (
                <tr key={table}>
                  <td>{table}</td>
                  <td>
                    <select
                      aria-label={`Concurrency policy for ${table}`}
                      value={policy}
                      onChange={(e) => save(table, { concurrency: e.target.value })}
                    >
                      {!policy && <option value="">Not set</option>}
                      {POLICIES.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {policy === "customAction" && (
                      <select
                        aria-label={`Action for ${table}`}
                        value={entity?.actionId ?? ""}
                        onChange={(e) => save(table, { actionId: e.target.value || null })}
                      >
                        <option value="">Choose an action</option>
                        {config.actions.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>
                    {!policy ? (
                      <span className="mode-badge rebuild">No resolved policy</span>
                    ) : missingAction ? (
                      <span className="mode-badge destructive">Action missing</span>
                    ) : (
                      <span className="mode-badge inPlace">Resolved</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {orphans.map((e) => (
        <p key={e.id}>
          Settings for missing table {e.table}{" "}
          <button
            type="button"
            onClick={() =>
              update(
                (draft) => ({ ...draft, entities: draft.entities.filter((x) => x.id !== e.id) }),
                `Remove entity ${e.table}`,
              )
            }
          >
            Remove settings for {e.table}
          </button>
        </p>
      ))}
    </div>
  );
}
