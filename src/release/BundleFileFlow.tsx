import { type FormEvent, type ReactNode, useId, useState } from "react";
import { asTauriError, type TauriError } from "../lib/api";
import { chooseBundleToOpen } from "../lib/dialog";
import { type OpenRequest, useEachRequest } from "../lib/launch";
import type { SessionState } from "../lib/types";
import { inspectRuntimeBundle, previewRuntimeUpdate } from "./api";
import { BundleError } from "./BundleError";
import type { BundleSummary, PendingMigration } from "./types";
import { UpdateConfirm } from "./UpdateConfirm";

type Act = (
  path: string,
  password: string,
  allowDowngrade: boolean,
  sha256: string,
) => Promise<SessionState>;
type Pending = { path: string; summary: BundleSummary };
type Confirm = Pending & { secret: string; migrations: PendingMigration[] | null };

/**
 * Choose a `.ixtr` file, verify it, ask for its password when protected, then run `act`
 * (open or update). An update or downgrade first shows its release notes and pending
 * migrations for confirmation; a downgrade is applied only from its explicit button.
 */
export function BundleFileFlow({
  act,
  request,
  onDone,
  onCancel,
  disabled,
  className,
  label,
  children,
}: {
  act: Act;
  /** A bundle the OS asked to open: runs the flow for it without the file dialog. */
  request?: OpenRequest | null;
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
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [password, setPassword] = useState("");
  const titleId = useId();

  const attempt = async (pending: Pending, secret: string, allowDowngrade = false) => {
    setBusy(true);
    setError(null);
    try {
      const state = await act(pending.path, secret, allowDowngrade, pending.summary.sha256);
      setPrompt(null);
      setDowngrade(null);
      setConfirm(null);
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

  // Updates and downgrades stop at the confirm step; everything else runs `act` right away.
  const proceed = async (pending: Pending, secret: string) => {
    const { action, pendingMigrations, migrationsUnavailable } = pending.summary;
    if (action !== "update" && action !== "downgrade") return attempt(pending, secret);
    setBusy(true);
    setError(null);
    try {
      const migrations =
        pendingMigrations ??
        (migrationsUnavailable ? null : await previewRuntimeUpdate(pending.path, secret));
      setPrompt(null);
      setConfirm({ ...pending, secret, migrations });
    } catch (reason) {
      const failure = asTauriError(reason);
      setError(failure);
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
    setConfirm(null);
    setPrompt(null);
    const path = await chooseBundleToOpen();
    if (typeof path !== "string" || !path) {
      onCancel?.();
      return;
    }
    await verify(path);
  };
  const verify = async (path: string) => {
    setError(null);
    setDowngrade(null);
    setConfirm(null);
    setPrompt(null);
    setBusy(true);
    try {
      const summary = await inspectRuntimeBundle(path);
      setBusy(false);
      if (summary.encrypted) setPrompt({ path, summary });
      else await proceed({ path, summary }, "");
    } catch (reason) {
      setBusy(false);
      setError(asTauriError(reason));
    }
  };
  useEachRequest(request, (opened) => {
    verify(opened.path).catch((reason: unknown) => setError(asTauriError(reason)));
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (prompt) proceed(prompt, password).catch(() => undefined);
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
      {confirm && (
        <UpdateConfirm
          name={confirm.summary.name}
          version={confirm.summary.version}
          installedVersion={confirm.summary.installedVersion}
          releaseNotes={confirm.summary.releaseNotes}
          migrations={confirm.migrations}
          migrationsUnavailable={confirm.summary.migrationsUnavailable}
          downgrade={confirm.summary.action === "downgrade"}
          busy={busy}
          onApply={() => {
            attempt(confirm, confirm.secret, confirm.summary.action === "downgrade").catch(
              () => undefined,
            );
          }}
          onCancel={() => {
            setConfirm(null);
            setPassword("");
            onCancel?.();
          }}
        />
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
