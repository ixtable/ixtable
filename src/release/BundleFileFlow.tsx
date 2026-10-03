import { type FormEvent, type ReactNode, useId, useState } from "react";
import { asTauriError, type TauriError } from "../lib/api";
import { chooseBundleToOpen } from "../lib/dialog";
import type { SessionState } from "../lib/types";
import { inspectRuntimeBundle } from "./api";
import { BundleError } from "./BundleError";
import type { BundleSummary } from "./types";

type Act = (path: string, password: string, allowDowngrade: boolean) => Promise<SessionState>;
type Pending = { path: string; summary: BundleSummary };

/**
 * Choose a `.ixtr` file, verify it, ask for its password when protected, then run `act`
 * (open or update). Errors are explained per code; a downgrade needs a second, explicit click.
 */
export function BundleFileFlow({
  act,
  onDone,
  onCancel,
  disabled,
  className,
  label,
  children,
}: {
  act: Act;
  onDone: (state: SessionState, summary: BundleSummary) => void;
  onCancel?: () => void;
  disabled?: boolean;
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TauriError | null>(null);
  const [prompt, setPrompt] = useState<Pending | null>(null);
  const [downgrade, setDowngrade] = useState<Pending | null>(null);
  const [password, setPassword] = useState("");
  const titleId = useId();

  const attempt = async (pending: Pending, secret: string, allowDowngrade = false) => {
    setBusy(true);
    setError(null);
    try {
      const state = await act(pending.path, secret, allowDowngrade);
      setPrompt(null);
      setDowngrade(null);
      setPassword("");
      onDone(state, pending.summary);
    } catch (reason) {
      const failure = asTauriError(reason);
      setError(failure);
      if (failure.code === "BUNDLE_DOWNGRADE") setDowngrade(pending);
      if (failure.code === "BUNDLE_PASSWORD" || failure.code === "BUNDLE_PASSWORD_REQUIRED") {
        setPrompt(pending);
      }
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setError(null);
    setDowngrade(null);
    setPrompt(null);
    const path = await chooseBundleToOpen();
    if (typeof path !== "string" || !path) {
      onCancel?.();
      return;
    }
    setBusy(true);
    try {
      const summary = await inspectRuntimeBundle(path);
      setBusy(false);
      if (summary.encrypted) setPrompt({ path, summary });
      else await attempt({ path, summary }, "");
    } catch (reason) {
      setBusy(false);
      setError(asTauriError(reason));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (prompt) attempt(prompt, password).catch(() => undefined);
  };

  return (
    <div className="bundle-flow">
      <button
        type="button"
        className={className}
        aria-label={label}
        disabled={disabled || busy}
        onClick={() => {
          start().catch((reason: unknown) => setError(asTauriError(reason)));
        }}
      >
        {children}
      </button>
      {busy && (
        <div className="progress" role="status">
          Verifying bundle…
        </div>
      )}
      {prompt && (
        <div className="bundle-password" role="dialog" aria-labelledby={titleId}>
          <form onSubmit={submit}>
            <h2 id={titleId}>
              Password for {prompt.summary.name} {prompt.summary.version}
            </h2>
            <label>
              Bundle password
              <input
                type="password"
                autoComplete="off"
                aria-label="Bundle password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <div className="settings-actions">
              <button type="submit" className="save" disabled={busy || !password}>
                Unlock
              </button>
              <button
                type="button"
                onClick={() => {
                  setPrompt(null);
                  setPassword("");
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
      {error && <BundleError error={error} />}
      {downgrade && (
        <div className="settings-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              attempt(downgrade, password, true).catch(() => undefined);
            }}
          >
            Install older version {downgrade.summary.version} anyway
          </button>
        </div>
      )}
    </div>
  );
}
