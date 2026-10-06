import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { DialogFrame } from "../components/DialogFrame";
import { asTauriError } from "../lib/api";
import { useShell } from "../shell/context";
import { clearRuntimeLogin, runtimeLoginStatus, setRuntimeLogin } from "./api";
import type { RuntimeLoginStatus } from "./types";

const databaseChanged = () => window.dispatchEvent(new Event("ixtable:database-changed"));

/**
 * Database login for a manually shared PostgreSQL bundle (PRD §9.3). The bundle
 * carries no password, so Runtime asks for one when none is stored or the
 * server refuses it, verifies it by connecting, and keeps it encrypted on this
 * computer for this installation. It can be changed or forgotten later.
 */
export function DatabaseLogin({ version }: { version?: string | null }) {
  const { setNotice } = useShell();
  const [status, setStatus] = useState<RuntimeLoginStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleId = useId();

  const show = useCallback((next: RuntimeLoginStatus) => {
    setStatus(next);
    setUser(next.user);
    setPassword("");
    setError("");
  }, []);

  useEffect(() => {
    let live = true;
    runtimeLoginStatus()
      .then((next) => {
        if (!live) return;
        show(next);
        setOpen(next.needsLogin);
      })
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [version, show]);

  if (!status?.applies) return null;

  const act = async (
    work: () => Promise<RuntimeLoginStatus>,
    done: (s: RuntimeLoginStatus) => void,
  ) => {
    setBusy(true);
    setError("");
    try {
      const next = await work();
      show(next);
      databaseChanged();
      done(next);
    } catch (reason) {
      const e = asTauriError(reason);
      setPassword("");
      setError(
        e.code === "AUTH_FAILED"
          ? `The database refused this login: ${e.message}`
          : `Could not connect: ${e.message}`,
      );
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    act(
      () => setRuntimeLogin(user.trim(), password),
      (next) => {
        setOpen(false);
        setNotice(
          `Connected to the database as ${next.user}. The login is saved on this computer.`,
        );
      },
    ).catch(() => undefined);
  };
  const forget = () => {
    act(clearRuntimeLogin, (next) => {
      setOpen(next.needsLogin);
      setNotice("The saved database login was removed from this computer.");
    }).catch(() => undefined);
  };

  return (
    <>
      <button type="button" className="runtime-bar-action" onClick={() => setOpen(true)}>
        Database login…
      </button>
      {open && (
        <DialogFrame
          className="bundle-password"
          role="dialog"
          aria-labelledby={titleId}
          busy={busy}
          onClose={() => setOpen(false)}
        >
          <h2 id={titleId}>Database login</h2>
          <p>
            This application stores its records in PostgreSQL database “{status.database}” on{" "}
            {status.host}. Enter the login you were given. ixtable checks it by connecting, then
            keeps it encrypted on this computer for this installation only.
          </p>
          {status.reason === "rejected" && (
            <p role="alert">The database refused the saved login. Enter it again.</p>
          )}
          {status.attached && <p role="status">Connected as {status.user}.</p>}
          <form onSubmit={submit}>
            <label>
              Database user
              <input
                value={user}
                required
                autoComplete="username"
                data-autofocus={!user || undefined}
                onChange={(e) => setUser(e.target.value)}
              />
            </label>
            <label>
              Database password
              <input
                type="password"
                value={password}
                required
                autoComplete="current-password"
                data-autofocus={user ? true : undefined}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <div className="settings-actions">
              <button type="submit" className="save" disabled={busy}>
                Connect
              </button>
              {status.source === "installation" && (
                <button type="button" disabled={busy} onClick={forget}>
                  Forget saved login
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </DialogFrame>
      )}
    </>
  );
}
