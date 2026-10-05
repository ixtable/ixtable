import { useCallback, useEffect, useState } from "react";
import { asTauriError, validateDocument } from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import type { Issue } from "../lib/types";
import { newId } from "../lib/utils";
import { useShell } from "../shell/context";
import {
  applyMigrations,
  dryRunMigrations,
  migrationHistory,
  migrationStatus,
  rollbackMigration,
} from "./api";
import { MigrationEditor } from "./MigrationEditor";
import type { Migration, MigrationLog, MigrationRun, MigrationStatus } from "./types";
import "../schema/schema.css";

function LogEntry({ log }: { log: MigrationLog }) {
  return (
    <li>
      <b>{log.name}</b> · {log.direction} · <span className="mode-badge">{log.status}</span>
      {log.startedAt && log.finishedAt && (
        <span>
          {" "}
          · {log.startedAt} to {log.finishedAt}
        </span>
      )}
      {log.health.length > 0 && (
        <span>
          {" "}
          · Health {log.health.some((h) => h.startsWith("failed")) ? "failed" : "passed"}:{" "}
          {log.health.join(", ")}
        </span>
      )}
      {log.error && <p className="schema-note severe">{log.error}</p>}
      {log.recovery && <p className="schema-note">Recovery: {log.recovery}</p>}
    </li>
  );
}

/** Old documents may say `any` (runs on SQLite) or `postgres` (not supported). */
const targetLabel = (target: Migration["targetStore"]) =>
  target === "postgres" ? "PostgreSQL (not supported)" : "SQLite";

/** Settings › Migrations: author, preview, dry-run, apply, and roll back migrations (PRD §24). */
export function MigrationsTab() {
  const { config, update, settled, reload } = useDocumentConfig();
  const { reloadMetadata, markDirty } = useShell();
  const [status, setStatus] = useState<MigrationStatus[]>([]);
  const [history, setHistory] = useState<MigrationLog[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [editing, setEditing] = useState<{ migration: Migration; isNew: boolean } | null>(null);
  const [run, setRun] = useState<MigrationRun | null>(null);
  const [dryRun, setDryRun] = useState<MigrationLog | null>(null);
  const [afterIssues, setAfterIssues] = useState<Issue[] | null>(null);
  // A dry run refused in preflight blocks Apply until the migrations change: Apply would be refused too.
  const [preflightFailed, setPreflightFailed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Migrations run on the embedded SQLite store only; PostgreSQL schema is managed externally.
  const postgres = config.datasource?.kind === "postgres";
  const migrations = [...config.migrations].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const refresh = useCallback(async () => {
    await settled();
    const [s, h, all] = await Promise.all([
      migrationStatus(),
      migrationHistory(),
      validateDocument(),
    ]);
    setStatus(s);
    setHistory(h);
    setIssues(all.filter((i) => i.objectKind === "migration"));
  }, [settled]);
  useEffect(() => {
    reload().catch(() => undefined);
  }, [reload]);
  useEffect(() => {
    refresh().catch((e) => setError(asTauriError(e).message));
  }, [refresh, config.migrations]);
  useEffect(() => {
    setPreflightFailed(false);
  }, [config.migrations]);

  const act = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(asTauriError(e).message);
    } finally {
      setBusy(false);
      refresh().catch(() => undefined);
    }
  };
  const save = async (next: Migration) => {
    await update(
      (draft) => ({
        ...draft,
        migrations: draft.migrations.some((m) => m.id === next.id)
          ? draft.migrations.map((m) => (m.id === next.id ? next : m))
          : [...draft.migrations, next],
      }),
      `Save migration ${next.name}`,
    );
    setEditing(null);
  };
  const remove = async (id: string) => {
    await update(
      (draft) => ({ ...draft, migrations: draft.migrations.filter((m) => m.id !== id) }),
      "Delete migration",
    );
    setEditing(null);
  };
  // Runs apply or rollback and lists only the definition problems the run introduced.
  const runAndCheck = async (task: () => Promise<MigrationRun>) => {
    setAfterIssues(null);
    const key = (i: Issue) => `${i.objectKind}|${i.objectId}|${i.message}`;
    const before = new Set((await validateDocument()).map(key));
    const result = await task();
    setRun(result);
    markDirty();
    await reloadMetadata();
    if (!result.ok) return;
    const all = await validateDocument();
    setAfterIssues(all.filter((i) => i.objectKind !== "migration" && !before.has(key(i))));
  };
  useEffect(() => {
    if (editing) setAfterIssues(null);
  }, [editing]);
  const statusOf = (id: string) => status.find((s) => s.id === id);
  const pendingCount = status.filter((s) => !s.applied && s.appliesToStore).length;

  return (
    <div className="settings-panel">
      <h2>Migrations</h2>
      <p>
        Ordered SQL changes to the embedded SQLite store, with immutable ids. Applying takes a
        recovery checkpoint first, runs each migration in one transaction, checks database health,
        and logs the result.
      </p>
      {postgres && (
        <p className="schema-note" role="note" aria-label="Migrations disabled">
          Migrations apply to the embedded SQLite store only and are disabled for this document
          because it uses PostgreSQL. Manage the external database schema yourself.
        </p>
      )}
      <div className="settings-actions">
        <button
          type="button"
          onClick={() =>
            setEditing({
              isNew: true,
              migration: {
                id: newId(),
                name: `Migration ${migrations.length + 1}`,
                order: Math.max(0, ...migrations.map((m) => m.order ?? 0)) + 1,
                targetStore: "sqlite",
                up: "",
                down: null,
                reversible: false,
                dependsOn: [],
              },
            })
          }
        >
          New migration
        </button>
        <button
          type="button"
          disabled={busy || postgres || !pendingCount}
          onClick={() =>
            act(async () => {
              setDryRun(null);
              setPreflightFailed(true);
              setDryRun(await dryRunMigrations());
              setPreflightFailed(false);
            })
          }
        >
          Dry run pending
        </button>
        <button
          type="button"
          className="save"
          disabled={busy || postgres || !pendingCount || preflightFailed}
          title={preflightFailed ? "Fix the migrations the dry run refused first." : undefined}
          onClick={() => act(() => runAndCheck(applyMigrations))}
        >
          Apply pending ({pendingCount})
        </button>
        <button
          type="button"
          disabled={busy || postgres || !status.some((s) => s.applied)}
          onClick={() => act(() => runAndCheck(rollbackMigration))}
        >
          Roll back last
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {issues.map((i, n) => (
        <p key={n} className={i.severity === "error" ? "schema-note severe" : "schema-note"}>
          {i.message}
        </p>
      ))}
      <table aria-label="Declared migrations">
        <thead>
          <tr>
            <th>Order</th>
            <th>Name</th>
            <th>Target</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {migrations.map((m) => {
            const s = statusOf(m.id);
            return (
              <tr key={m.id}>
                <td>{m.order ?? 0}</td>
                <td>{m.name}</td>
                <td>{targetLabel(m.targetStore)}</td>
                <td>
                  {s?.modified
                    ? "Changed after apply"
                    : s?.applied
                      ? "Applied"
                      : postgres
                        ? "Disabled"
                        : s && !s.appliesToStore
                          ? "Not supported"
                          : "Pending"}
                </td>
                <td>
                  <button type="button" onClick={() => setEditing({ migration: m, isNew: false })}>
                    Edit {m.name}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editing && (
        <MigrationEditor
          key={editing.migration.id}
          migration={editing.migration}
          isNew={editing.isNew}
          applied={!!statusOf(editing.migration.id)?.applied}
          others={migrations.filter((m) => m.id !== editing.migration.id)}
          onSave={save}
          onDelete={() => remove(editing.migration.id)}
          onClose={() => setEditing(null)}
        />
      )}
      {dryRun && (
        <section aria-label="Dry run result">
          <h3>Dry run</h3>
          <p role="status">
            {dryRun.status === "dry_run_ok"
              ? "Dry run succeeded; nothing was changed."
              : "Dry run failed; nothing was changed."}
          </p>
          <ul>
            <LogEntry log={dryRun} />
          </ul>
        </section>
      )}
      {run && (
        <section aria-label="Last run">
          <h3>Last run</h3>
          <p role="status">
            {run.ok ? "All migrations succeeded." : "A migration failed; later ones did not run."}
            {run.checkpoint && ` Checkpoint ${run.checkpoint.id} was saved first.`}
          </p>
          <ul>
            {run.logs.map((log, i) => (
              <LogEntry key={i} log={log} />
            ))}
          </ul>
        </section>
      )}
      {afterIssues && afterIssues.length > 0 && (
        <section aria-label="Problems after migration">
          <h3>Problems after migration</h3>
          <p>The schema changed. These definitions need attention (also listed in Problems).</p>
          <ul>
            {afterIssues.map((i, n) => (
              <li key={n} className={i.severity === "error" ? "schema-note severe" : "schema-note"}>
                {i.message}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label="Migration log">
        <h3>Migration log</h3>
        {!history.length && <p>No migrations have run on this store.</p>}
        <ul>
          {history.map((log, i) => (
            <LogEntry key={i} log={log} />
          ))}
        </ul>
      </section>
    </div>
  );
}
