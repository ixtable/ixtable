import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { desktopAuthPoll, desktopAuthStart } from "./api";
import {
  adoptSession,
  invokeFunction,
  requestPasswordReset,
  signInWithPassword,
  signOut,
  signUp,
} from "./client";
import { CloudErrorNotice } from "./CloudErrorNotice";
import { invitationToken } from "./contract";
import { CloudError, toCloudError } from "./errors";

const POLL_MS = 2000;
const POLL_LIMIT = 450;

/** Email/password sign-in and sign-up, plus Google/Microsoft through the browser. */
export function SignInPanel({ purpose }: { purpose: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<CloudError | null>(null);
  const [notice, setNotice] = useState("");
  const [handoff, setHandoff] = useState<{ url: string; opened: boolean } | null>(null);
  const cancelled = useRef(false);
  const formId = useId();
  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice("");
    try {
      await action();
    } catch (reason) {
      setError(await toCloudError(reason));
    } finally {
      setBusy("");
    }
  };
  const submit = (event: FormEvent, mode: "in" | "up") => {
    event.preventDefault();
    run(mode === "in" ? "Signing in…" : "Creating account…", async () => {
      const session =
        mode === "in" ? await signInWithPassword(email, password) : await signUp(email, password);
      if (!session) setNotice("Check your email to confirm the account, then sign in.");
    }).catch(() => undefined);
  };
  const forgot = () =>
    run("Sending the reset email…", async () => {
      if (!email.trim())
        throw new CloudError(
          "VALIDATION",
          "Enter your email address, then choose Forgot password.",
        );
      await requestPasswordReset(email.trim());
      setNotice(
        `If ${email.trim()} has an account, a password reset email is on its way. Open its link to choose a new password, then sign in here.`,
      );
    });
  const browser = (provider: "google" | "azure") =>
    run("Waiting for the browser sign-in…", async () => {
      cancelled.current = false;
      const start = await desktopAuthStart(provider);
      setHandoff({ url: start.url, opened: start.opened });
      for (let attempt = 0; attempt < POLL_LIMIT && !cancelled.current; attempt++) {
        const result = await desktopAuthPoll(start.state);
        if (result.status === "approved" && result.session) {
          await adoptSession(result.session);
          setHandoff(null);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      setHandoff(null);
      if (!cancelled.current)
        throw new CloudError("AUTH_EXPIRED", "The browser sign-in was not completed in time.");
    });

  return (
    <section className="cloud-card" aria-labelledby={`${formId}-title`}>
      <h2 id={`${formId}-title`}>Sign in to ixtable Cloud</h2>
      <p className="cloud-muted">{purpose}</p>
      <form className="cloud-form" onSubmit={(event) => submit(event, "in")}>
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="cloud-actions">
          <button type="submit" className="save" disabled={!!busy}>
            Sign in
          </button>
          <button type="button" disabled={!!busy} onClick={(event) => submit(event, "up")}>
            Create account
          </button>
          <button type="button" className="text-button" disabled={!!busy} onClick={forgot}>
            Forgot password?
          </button>
        </div>
      </form>
      <div className="cloud-actions">
        <button type="button" disabled={!!busy} onClick={() => browser("google")}>
          Sign in with Google
        </button>
        <button type="button" disabled={!!busy} onClick={() => browser("azure")}>
          Sign in with Microsoft
        </button>
      </div>
      {handoff && (
        <p className="cloud-muted" role="status">
          {handoff.opened
            ? "Finish signing in in your browser. This window continues automatically."
            : "Open this address in your browser to finish signing in: "}
          {!handoff.opened && <code>{handoff.url}</code>}{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              cancelled.current = true;
            }}
          >
            Cancel
          </button>
        </p>
      )}
      {busy && (
        <p className="cloud-muted" role="status">
          {busy}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <CloudErrorNotice error={error} />}
    </section>
  );
}

/** Accepts an emailed invitation from the desktop (`invitations-accept`). */
export function AcceptInvitation({ onAccepted }: { onAccepted: () => void }) {
  const [link, setLink] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CloudError | null>(null);
  const [notice, setNotice] = useState("");
  const accept = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice("");
    const token = invitationToken(link);
    if (!token) {
      setError(
        new CloudError(
          "VALIDATION",
          "Paste the invitation link from the email (it contains token=…).",
        ),
      );
      return;
    }
    setBusy(true);
    try {
      const { membership } = await invokeFunction("invitations-accept", { token });
      setLink("");
      setOpen(false);
      setNotice(
        membership.kind === "app"
          ? "Invitation accepted. The application is listed below."
          : "Invitation accepted. You joined the organization.",
      );
      onAccepted();
    } catch (reason) {
      setError(await toCloudError(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cloud-invite">
      {open ? (
        <form className="cloud-form" onSubmit={accept}>
          <label>
            Invitation link
            <input
              type="text"
              autoComplete="off"
              placeholder="https://…/invite?token=…"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
          </label>
          <div className="cloud-actions">
            <button type="submit" className="save" disabled={busy || !link.trim()}>
              Accept invitation
            </button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="text-button" onClick={() => setOpen(true)}>
          Accept an invitation…
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <CloudErrorNotice error={error} />}
    </div>
  );
}

/** "Signed in as …" with a sign-out button. */
export function AccountLine({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <p className="cloud-account">
      Signed in as <b>{email}</b>{" "}
      <button
        type="button"
        className="text-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          signOut().finally(() => setBusy(false));
        }}
      >
        Sign out
      </button>
    </p>
  );
}
