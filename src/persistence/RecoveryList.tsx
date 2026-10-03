import { History, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { asTauriError, type TauriError } from "../lib/api";
import type { SessionState } from "../lib/types";
import { discardRecovery, listRecoverableSessions, recoverWork } from "./api";
import type { RecoveryRecord } from "./types";

const label = (record: RecoveryRecord) =>
  record.name || record.documentPath?.split(/[\\/]/).pop() || "Untitled document";

/**
 * Start-screen list of unsaved work left by sessions that ended without closing
 * (PRD §7.2). Recover reopens it and saves it back into its .ixt; Discard deletes it.
 */
export function RecoveryList({
  disabled,
  run,
  onError,
}: {
  disabled: boolean;
  // The start screen's action runner: shows progress and opens the returned session.
  run: (label: string, action: () => Promise<SessionState | null>) => Promise<void>;
  onError: (error: TauriError) => void;
}) {
  const [records, setRecords] = useState<RecoveryRecord[]>([]);
  const refresh = useCallback(
    () =>
      listRecoverableSessions()
        .then(setRecords)
        .catch(() => setRecords([])),
    [],
  );
  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  if (!records.length) return null;
  const discard = async (record: RecoveryRecord) => {
    if (!window.confirm(`Discard the unsaved work in ${label(record)}? This cannot be undone.`))
      return;
    try {
      await discardRecovery(record.sessionId);
    } catch (reason) {
      onError(asTauriError(reason));
    }
    await refresh();
  };
  const recover = async (record: RecoveryRecord) => {
    await run(`Recovering ${label(record)}…`, () => recoverWork(record));
    await refresh();
  };

  return (
    <section className="start-section recovery-section" aria-labelledby="recover-unsaved-work">
      <div>
        <h2 id="recover-unsaved-work">Recover unsaved work</h2>
      </div>
      <p className="recovery-intro">
        ixtable closed before these changes were saved. Recover them to save them back into their
        document, or discard them.
      </p>
      <ul className="recent-list recovery-list">
        {records.map((record) => (
          <li key={record.sessionId}>
            <div className="recovery-item">
              <History aria-hidden />
              <span>
                <b>{label(record)}</b>
                <small>{record.documentPath ?? "Never saved"}</small>
              </span>
              <time dateTime={record.updatedAt}>{new Date(record.updatedAt).toLocaleString()}</time>
              <button
                disabled={disabled}
                aria-label={`Recover ${label(record)}`}
                onClick={() => {
                  recover(record).catch(() => undefined);
                }}
              >
                Recover
              </button>
              <button
                disabled={disabled}
                aria-label={`Discard ${label(record)}`}
                onClick={() => {
                  discard(record).catch(() => undefined);
                }}
              >
                <Trash2 aria-hidden />
                Discard
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
