import { useEffect, useId, useState } from "react";
import { DialogFrame } from "../components/DialogFrame";
import { asTauriError, type TauriError } from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import { useShell } from "../shell/context";
import {
  previewInstallationReset,
  resetRuntimeInstallationData,
  runtimeInstallationInfo,
  updateRuntimeInstallation,
} from "./api";
import { BundleError } from "./BundleError";
import { BundleFileFlow } from "./BundleFileFlow";
import { DatabaseLogin } from "./DatabaseLogin";
import type { InstalledBundle, ResetPreview } from "./types";

/** Sidebar block for runtime-only windows: bundle name/version, manual update, data reset. */
export function RuntimeBar() {
  const { doc, applySession, setNotice } = useShell();
  const { reload } = useDocumentConfig();
  const [info, setInfo] = useState<InstalledBundle | null>(null);
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [error, setError] = useState<TauriError | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();

  useEffect(() => {
    runtimeInstallationInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [doc.bundleVersion]);

  const refresh = async () => {
    await reload();
    window.dispatchEvent(new Event("ixtable:database-changed"));
  };

  const showReset = async () => {
    setError(null);
    try {
      setPreview(await previewInstallationReset());
    } catch (reason) {
      setError(asTauriError(reason));
    }
  };
  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      applySession(await resetRuntimeInstallationData());
      setPreview(null);
      await refresh();
      setNotice("Installation data was reset from the bundle. A recovery copy was kept.");
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="runtime-bar" aria-label="Runtime bundle">
      <div className="document-label">
        <small>RUNTIME BUNDLE</small>
        <strong>{info?.name ?? doc.name}</strong>
        <span>Version {doc.bundleVersion ?? info?.version}</span>
      </div>
      <BundleFileFlow
        className="runtime-bar-action"
        act={updateRuntimeInstallation}
        onDone={(state) => {
          applySession(state);
          refresh().catch(() => undefined);
          setNotice(`Updated to version ${state.bundleVersion ?? ""}. Your records were kept.`);
        }}
      >
        Check for update…
      </BundleFileFlow>
      <DatabaseLogin version={doc.bundleVersion} />
      <button
        type="button"
        className="runtime-bar-action danger"
        disabled={busy}
        onClick={() => {
          showReset().catch(() => undefined);
        }}
      >
        Reset installation data…
      </button>
      {preview && (
        <DialogFrame
          className="bundle-password"
          role="dialog"
          aria-labelledby={titleId}
          busy={busy}
          onClose={() => setPreview(null)}
        >
          <h2 id={titleId}>Reset installation data?</h2>
          <p>{preview.message}</p>
          <ul>
            {preview.current.map((table) => (
              <li key={table.name}>
                {table.name}: {table.rows} now,{" "}
                {preview.bundled.find((b) => b.name === table.name)?.rows ?? 0} after reset
              </li>
            ))}
          </ul>
          <div className="settings-actions">
            <button
              type="button"
              className="save danger"
              disabled={busy}
              onClick={() => {
                reset().catch(() => undefined);
              }}
            >
              Replace all records
            </button>
            <button type="button" data-autofocus onClick={() => setPreview(null)}>
              Keep my records
            </button>
          </div>
        </DialogFrame>
      )}
      {error && <BundleError error={error} />}
    </section>
  );
}
