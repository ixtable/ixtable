import { useEffect, useId, useState } from "react";
import { asTauriError } from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import { newId } from "../lib/utils";
import { useShell } from "../shell/context";
import {
  clearDatasourcePassword,
  connectDatasource,
  setDatasourcePassword,
  storeCapabilities,
  testDatasourceConnection,
} from "./api";
import { CapabilitySummary } from "./CapabilitySummary";
import { modeLabel, storeLabel } from "./logical";
import type { ConnectionReport, DatasourceConfig, StoreCapabilities } from "./types";
import "./schema.css";

const SSL_MODES = [
  { value: "verify-full", label: "verify-full (TLS, verify certificate and host)" },
  { value: "verify-ca", label: "verify-ca (TLS, verify certificate)" },
  { value: "require", label: "require (TLS, no verification)" },
  { value: "prefer", label: "prefer (TLS if offered, else plaintext)" },
  { value: "disable", label: "disable (no TLS)" },
];
const PLAINTEXT = ["disable", "allow", "prefer"];

const withDefaults = (ds: DatasourceConfig): DatasourceConfig => ({
  port: 5432,
  sslmode: "require",
  schema: "public",
  credentialMode: "shared",
  host: "",
  database: "",
  user: "",
  ...ds,
});

/** Settings › Datasource: embedded SQLite or a developer-supplied PostgreSQL (PRD §9, §21.4). */
export function DatasourceTab() {
  const { config, update, settled } = useDocumentConfig();
  const shell = useShell();
  const [draft, setDraft] = useState<DatasourceConfig>(withDefaults(config.datasource));
  const [password, setPassword] = useState("");
  const [report, setReport] = useState<ConnectionReport | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [capabilities, setCapabilities] = useState<StoreCapabilities | null>(null);
  const ackId = useId();
  useEffect(() => setDraft(withDefaults(config.datasource)), [config.datasource]);
  useEffect(() => {
    storeCapabilities()
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
  }, [config.datasource.kind]);
  const postgres = draft.kind === "postgres";
  const plaintext = postgres && PLAINTEXT.includes(draft.sslmode ?? "require");
  const set = (patch: Partial<DatasourceConfig>) => setDraft((d) => ({ ...d, ...patch }));
  const blocked = plaintext && !draft.insecureTransportConfirmed;

  const test = async () => {
    setBusy(true);
    setError("");
    setReport(null);
    try {
      setReport(await testDatasourceConnection(draft, password));
    } catch (e) {
      setError(asTauriError(e).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const id = draft.id || newId();
      let passwordRef = draft.passwordRef ?? null;
      if (password)
        passwordRef = await setDatasourcePassword(id, password, {
          ...draft,
          id,
          port: draft.port || 5432,
        });
      const next: DatasourceConfig = {
        ...draft,
        port: draft.port || 5432,
        id,
        passwordRef,
        insecureTransportConfirmedAt: plaintext
          ? (draft.insecureTransportConfirmedAt ?? new Date().toISOString())
          : null,
        insecureTransportConfirmed: plaintext ? !!draft.insecureTransportConfirmed : false,
      };
      await update((c) => ({ ...c, datasource: next }), "Change datasource");
      await settled();
      setPassword("");
      const attached = await connectDatasource();
      setStatus(
        attached.attached
          ? `Saved. Reads now use the ${attached.kind === "postgres" ? "PostgreSQL" : "embedded SQLite"} store.`
          : `Saved, but the store is not reachable: ${attached.error ?? "unknown error"}`,
      );
      await shell.reloadMetadata();
    } catch (e) {
      setError(asTauriError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-panel">
      <h2>Datasource</h2>
      <p>
        Records are written to this store and read through DuckDB. PostgreSQL hosting, backups, and
        availability are yours to provide.
      </p>
      <div className="settings-form">
        <label>
          Record store
          <select value={draft.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="sqlite">Embedded SQLite (in the .ixt file)</option>
            <option value="postgres">PostgreSQL</option>
          </select>
        </label>
        {postgres && (
          <>
            <label>
              Host
              <input value={draft.host ?? ""} onChange={(e) => set({ host: e.target.value })} />
            </label>
            <label>
              Port
              <input
                type="number"
                value={draft.port ?? ""}
                onChange={(e) =>
                  set({ port: e.target.value === "" ? undefined : Number(e.target.value) })
                }
              />
            </label>
            <label>
              Database
              <input
                value={draft.database ?? ""}
                onChange={(e) => set({ database: e.target.value })}
              />
            </label>
            <label>
              User
              <input value={draft.user ?? ""} onChange={(e) => set({ user: e.target.value })} />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="new-password"
                placeholder={draft.passwordRef ? "Stored on this computer" : ""}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              Schema
              <input value={draft.schema ?? ""} onChange={(e) => set({ schema: e.target.value })} />
            </label>
            <label>
              TLS (sslmode)
              <select
                value={draft.sslmode}
                onChange={(e) =>
                  set({ sslmode: e.target.value, insecureTransportConfirmed: false })
                }
              >
                {SSL_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Credential mode
              <select
                value={draft.credentialMode}
                onChange={(e) => set({ credentialMode: e.target.value })}
              >
                <option value="shared">One shared application credential</option>
                <option value="perUser">A least-privileged credential per runtime user</option>
              </select>
            </label>
          </>
        )}
      </div>
      {postgres && (
        <p className="schema-note">
          The password is sealed in this computer&apos;s local secret store; the application file
          keeps only a reference to it.
        </p>
      )}
      {postgres && draft.credentialMode === "shared" && (
        <p className="schema-note" role="note">
          Shared credentials reduce revocation and database-level attribution: every runtime user
          connects as the same database role.
        </p>
      )}
      {plaintext && (
        <div className="schema-note severe" role="alert">
          <b>Severe security warning.</b> With sslmode “{draft.sslmode}” credentials and records can
          travel over the network unencrypted. The override is recorded in the application and shown
          before publishing.
          <label className="mt-2 flex items-center gap-2" htmlFor={ackId}>
            <input
              id={ackId}
              type="checkbox"
              checked={!!draft.insecureTransportConfirmed}
              onChange={(e) => set({ insecureTransportConfirmed: e.target.checked })}
            />
            I accept connecting without TLS for this datasource
          </label>
        </div>
      )}
      <div className="settings-actions">
        <button type="button" disabled={busy || blocked} onClick={test}>
          Test connection
        </button>
        {postgres && config.datasource.passwordRef && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              const ref = config.datasource.passwordRef;
              if (!ref) return;
              try {
                await clearDatasourcePassword(ref);
                await update(
                  (c) => ({ ...c, datasource: { ...c.datasource, passwordRef: null } }),
                  "Forget datasource password",
                );
                setStatus("The stored password was removed from this computer.");
              } catch (e) {
                setError(asTauriError(e).message);
              }
            }}
          >
            Forget stored password
          </button>
        )}
        <button type="button" className="save" disabled={busy || blocked} onClick={save}>
          Save datasource
        </button>
      </div>
      {report && (
        <p role="status" className={report.ok ? "schema-note" : "schema-note severe"}>
          {report.ok ? "Connection succeeded" : "Connection failed"}
          {report.serverVersion ? ` (server ${report.serverVersion})` : ""}: {report.message}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {capabilities && (
        <details>
          <summary>{storeLabel(capabilities)} store capabilities</summary>
          <CapabilitySummary capabilities={capabilities} />
          <table aria-label="Logical type mapping">
            <thead>
              <tr>
                <th>Logical type</th>
                <th>Stored as</th>
                <th>Enforcement</th>
              </tr>
            </thead>
            <tbody>
              {capabilities.logicalTypes.map((t) => (
                <tr key={t.logicalType}>
                  <td>{t.logicalType}</td>
                  <td>{t.physicalType}</td>
                  <td>
                    {t.enforcement}
                    {t.maxPrecision ? ` · up to ${t.maxPrecision} digits` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table aria-label="Schema change modes">
            <thead>
              <tr>
                <th>Change</th>
                <th>Mode</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {capabilities.ddl.map((d) => (
                <tr key={d.operation}>
                  <td>{d.operation.replaceAll("_", " ")}</td>
                  <td>{modeLabel(d.mode)}</td>
                  <td>{d.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
