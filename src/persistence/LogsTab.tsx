import { useCallback, useEffect, useState } from "react";
import { asTauriError, type TauriError } from "../lib/api";
import { readLogs } from "./api";
import type { LogEntry } from "./types";

const LIMIT = 200;
const asText = (entries: LogEntry[]) =>
  entries.map((e) => `${e.timestamp}\t${e.level}\t${e.area}\t${e.message}`).join("\n");

/** Local diagnostic log (PRD §27.5): recent lines with secrets already redacted. */
export function LogsTab() {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<TauriError | null>(null);
  const [status, setStatus] = useState("");
  const refresh = useCallback(async () => {
    setError(null);
    try {
      setEntries(await readLogs(LIMIT));
    } catch (reason) {
      setError(asTauriError(reason));
    }
  }, []);
  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText(entries ?? []));
      setStatus(`Copied ${entries?.length ?? 0} log lines.`);
    } catch (reason) {
      setError(asTauriError(reason));
    }
  };

  return (
    <div className="settings-panel logs-panel">
      <h2>Logs</h2>
      <p>
        Saves, autosaves, recovery, checkpoints, and format upgrades are logged on this computer
        only. Passwords and connection-string credentials are removed before writing.
      </p>
      <div className="settings-actions">
        <button
          onClick={() => {
            setStatus("");
            refresh().catch(() => undefined);
          }}
        >
          Refresh
        </button>
        <button disabled={!entries?.length} onClick={() => copy()}>
          Copy
        </button>
        <span>{entries ? `${entries.length} recent lines` : "Loading…"}</span>
      </div>
      {error && (
        <div className="error" role="alert">
          <b>{error.code}</b>
          <span>{error.message}</span>
        </div>
      )}
      {status && <p role="status">{status}</p>}
      {entries?.length === 0 && <p>No log entries yet.</p>}
      {!!entries?.length && (
        <ol className="log-lines" aria-label="Log entries">
          {[...entries].reverse().map((entry, index) => (
            <li key={`${entry.timestamp}-${index}`} className={`log-${entry.level.toLowerCase()}`}>
              <time dateTime={entry.timestamp}>{entry.timestamp}</time>
              <b>{entry.level}</b>
              <span className="log-area">{entry.area}</span>
              <span>{entry.message}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
