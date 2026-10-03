import { useCallback, useEffect, useState } from "react";
import { asTauriError, type TauriError } from "../lib/api";
import { useShell } from "../shell/context";
import { createCheckpoint, listCheckpoints, restoreCheckpointAsCopy } from "./api";
import { chooseCheckpointCopyDestination } from "./dialog";
import { formatBytes, formatDateTime } from "./format";
import type { CheckpointInfo } from "./types";

/** Local checkpoints of this document: create one now, or restore one as a separate copy. */
export function CheckpointsPanel() {
  const { doc } = useShell();
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TauriError | null>(null);
  const [status, setStatus] = useState("");
  const refresh = useCallback(async () => setCheckpoints(await listCheckpoints()), []);
  useEffect(() => {
    refresh().catch((reason: unknown) => setError(asTauriError(reason)));
  }, [refresh]);

  const act = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      setStatus(await action());
      await refresh();
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    act(async () => {
      await createCheckpoint("manual");
      return "Checkpoint created.";
    });
  const restore = (checkpoint: CheckpointInfo) =>
    act(async () => {
      const path = await chooseCheckpointCopyDestination(`${doc.name} (restored)`);
      if (!path) return "Restore canceled.";
      const written = await restoreCheckpointAsCopy(checkpoint.id, path);
      return `Restored a copy to ${written}. Open it from Recent documents.`;
    });

  return (
    <section className="settings-section" aria-labelledby="checkpoints">
      <h3 id="checkpoints">Checkpoints</h3>
      <p>
        Local copies of this application, including unsaved changes. ixtable also creates one before
        migrations and recovery.
      </p>
      <div className="settings-actions">
        <button disabled={busy} onClick={create}>
          Create checkpoint
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          <b>{error.code}</b>
          <span>{error.message}</span>
        </div>
      )}
      {status && <p role="status">{status}</p>}
      {checkpoints.length ? (
        <ul className="checkpoint-list" aria-label="Checkpoints">
          {checkpoints.map((checkpoint) => (
            <li key={checkpoint.id}>
              <span>
                <b>{formatDateTime(checkpoint.createdAt)}</b>
                <small>
                  {checkpoint.reason} · {formatBytes(checkpoint.size)}
                </small>
              </span>
              <button
                disabled={busy}
                aria-label={`Restore checkpoint from ${formatDateTime(checkpoint.createdAt)} as a copy`}
                onClick={() => restore(checkpoint)}
              >
                Restore as copy
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p>No checkpoints yet.</p>
      )}
    </section>
  );
}
