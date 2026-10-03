import { type FormEvent, useState } from "react";
import { asTauriError, type TauriError } from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import { chooseBundleDestination } from "../lib/dialog";
import { useShell } from "../shell/context";
import { documentState, exportRuntimeBundle } from "./api";
import { BundleError } from "./BundleError";
import type { BundleInfo } from "./types";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const isSemver = (value: string) => SEMVER.test(value.trim());

const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

/** Settings → Release: version, notes, optional password, and runtime-only bundle export. */
export function ReleaseTab() {
  const { config, update, settled } = useDocumentConfig();
  const { applySession } = useShell();
  const [version, setVersion] = useState(config.release?.version || "1.0.0");
  const [notes, setNotes] = useState(config.release?.notes ?? "");
  const [minRuntime, setMinRuntime] = useState(config.release?.minRuntimeVersion ?? "");
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TauriError | null>(null);
  const [info, setInfo] = useState<BundleInfo | null>(null);
  const [status, setStatus] = useState("");

  const versionError = isSemver(version) ? "" : "Enter a semantic version such as 1.2.0.";
  const minError =
    !minRuntime.trim() || isSemver(minRuntime) ? "" : "Enter a semantic version or leave blank.";
  const passwordError = !protect
    ? ""
    : password.length < 8
      ? "Use at least 8 characters."
      : password !== confirm
        ? "The passwords do not match."
        : "";
  const invalid = !!(versionError || minError || passwordError);

  const exportBundle = async (event: FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    setStatus("");
    try {
      const release = {
        version: version.trim(),
        notes,
        minRuntimeVersion: minRuntime.trim() || null,
      };
      await update((draft) => ({ ...draft, release }), "Edit release");
      await settled();
      const path = await chooseBundleDestination(`${config.name}-${release.version}`);
      if (!path) {
        setStatus("Export canceled.");
        return;
      }
      const result = await exportRuntimeBundle(path, {
        version: release.version,
        releaseNotes: notes,
        minRuntimeVersion: release.minRuntimeVersion,
        password: protect ? password : null,
      });
      setInfo(result);
      setPassword("");
      setConfirm("");
      applySession(await documentState());
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-panel release-panel" onSubmit={exportBundle} noValidate>
      <h2>Release</h2>
      <p>
        Export a signed, runtime-only bundle (.ixtr). Recipients open it with ixtable Runtime
        without Studio access. Its records seed each installation on first open; later updates keep
        the recipient&apos;s records and apply your migrations.
      </p>
      <div className="release-fields">
        <label>
          Version
          <input
            aria-label="Version"
            value={version}
            aria-invalid={!!versionError}
            aria-describedby="release-version-hint"
            onChange={(event) => setVersion(event.target.value)}
          />
          <small id="release-version-hint" className={versionError ? "field-error" : ""}>
            {versionError || "Semantic version; each update needs a higher version."}
          </small>
        </label>
        <label>
          Minimum Runtime version
          <input
            aria-label="Minimum Runtime version"
            value={minRuntime}
            placeholder="Any"
            aria-invalid={!!minError}
            aria-describedby="release-min-hint"
            onChange={(event) => setMinRuntime(event.target.value)}
          />
          <small id="release-min-hint" className={minError ? "field-error" : ""}>
            {minError || "Older Runtimes refuse the bundle."}
          </small>
        </label>
        <label className="wide">
          Release notes
          <textarea
            aria-label="Release notes"
            value={notes}
            rows={4}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
      </div>
      <fieldset className="release-password">
        <legend>Password protection</legend>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={protect}
            onChange={(event) => setProtect(event.target.checked)}
          />
          Protect the bundle with a password
        </label>
        <p className="caveat">
          A password protects the bundle at rest and against casual unauthorized opening. It does
          not stop an authorized recipient from extracting displayed data or runtime-accessible
          credentials.
        </p>
        {protect && (
          <div className="release-fields">
            <label>
              Password
              <input
                type="password"
                autoComplete="new-password"
                aria-label="Password"
                value={password}
                aria-invalid={!!passwordError}
                aria-describedby="release-password-hint"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                aria-label="Confirm password"
                value={confirm}
                aria-invalid={!!passwordError}
                aria-describedby="release-password-hint"
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
            <small id="release-password-hint" className={passwordError ? "field-error" : ""}>
              {passwordError || "Share the password separately from the file."}
            </small>
          </div>
        )}
      </fieldset>
      <div className="settings-actions">
        <button type="submit" className="save" disabled={busy || invalid}>
          Export runtime bundle…
        </button>
        {busy && <span role="status">Exporting…</span>}
        {status && <span role="status">{status}</span>}
      </div>
      {error && <BundleError error={error} />}
      {info && (
        <section className="bundle-info" aria-label="Exported bundle">
          <h3>
            Exported {info.name} {info.version}
          </h3>
          <dl>
            <dt>File</dt>
            <dd>{info.path}</dd>
            <dt>Size</dt>
            <dd>{formatSize(info.size)}</dd>
            <dt>SHA-256</dt>
            <dd>
              <code>{info.sha256}</code>
            </dd>
            <dt>Signer fingerprint</dt>
            <dd>
              <code>{info.signerFingerprint}</code>
            </dd>
            <dt>Password protected</dt>
            <dd>{info.encrypted ? "Yes" : "No"}</dd>
          </dl>
          <p>
            The signing key is stored on this computer only. It is a local developer key, not an
            ixtable Cloud identity; recipients pin it on first open and refuse updates signed by
            another key.
          </p>
        </section>
      )}
    </form>
  );
}
