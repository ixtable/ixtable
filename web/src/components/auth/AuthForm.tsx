import React, { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import Link from "@docusaurus/Link";
import { useHistory, useLocation } from "@docusaurus/router";
import { useAuth, type OAuthProvider } from "@site/src/contexts/AuthContext";
import { safeNext } from "@site/src/lib/cloud";

type Mode = "signin" | "signup";

const PROVIDERS: { id: OAuthProvider; label: string; testId: string }[] = [
  { id: "google", label: "Continue with Google", testId: "oauth-google-button" },
  { id: "azure", label: "Continue with Microsoft", testId: "oauth-microsoft-button" },
];

function OAuthButtons({
  next,
  onError,
}: {
  next: string;
  onError: (message: string) => void;
}): ReactNode {
  const { providers, signInWithOAuth } = useAuth();
  const hintId = useId();
  const anyDisabled = PROVIDERS.some((provider) => !providers[provider.id]);
  return (
    <div className="auth-oauth">
      {PROVIDERS.map((provider) => (
        <button
          key={provider.id}
          type="button"
          className="button button--secondary button--block"
          disabled={!providers[provider.id]}
          aria-describedby={providers[provider.id] ? undefined : hintId}
          onClick={async () => {
            const result = await signInWithOAuth(provider.id, next);
            if (result.error) onError(result.error);
          }}
          data-testid={provider.testId}
        >
          {provider.label}
        </button>
      ))}
      {anyDisabled && (
        <p id={hintId} className="cloud-muted auth-oauth__hint" data-testid="oauth-disabled-hint">
          Some sign-in providers are not configured in this environment. Use your email and password
          instead.
        </p>
      )}
    </div>
  );
}

export default function AuthForm({ initialMode }: { initialMode: Mode }): ReactNode {
  const { user, loading, signIn, signUp } = useAuth();
  const history = useHistory();
  const location = useLocation();
  const next = safeNext(new URLSearchParams(location.search).get("next"));
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);
  const errorId = useId();

  useEffect(() => {
    if (!loading && user) history.replace(next);
  }, [loading, user, history, next]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    if (mode === "signin") {
      const result = await signIn(email, password);
      setSubmitting(false);
      if (result.error) setError(result.error);
      return;
    }
    const result = await signUp(email, password, next);
    setSubmitting(false);
    if (result.error) setError(result.error);
    else if (result.needsConfirmation) setConfirmationSent(true);
  };

  const heading = mode === "signin" ? "Log in" : "Create an account";
  const desktopProvider = next.startsWith("/desktop-auth")
    ? PROVIDERS.find(
        (provider) => new URLSearchParams(next.split("?")[1] ?? "").get("provider") === provider.id,
      )
    : undefined;
  const nextQuery = next === "/account" ? "" : `?next=${encodeURIComponent(next)}`;

  return (
    <div className="auth-form">
      <h1>{heading}</h1>
      {next.startsWith("/desktop-auth") ? (
        <div className="alert alert--info" role="status" data-testid="login-desktop-hint">
          Sign in to approve the ixtable desktop app.
          {desktopProvider &&
            ` The app asked you to use ${desktopProvider.label.replace("Continue with ", "")}.`}
        </div>
      ) : (
        <p className="cloud-muted">
          Your ixtable account manages cloud apps, runtime users, and billing. The desktop app works
          without one.
        </p>
      )}
      <div className="button-group auth-tabs" role="group" aria-label="Choose log in or sign up">
        <button
          type="button"
          aria-pressed={mode === "signin"}
          className={`button button--sm ${mode === "signin" ? "button--primary" : "button--secondary"}`}
          onClick={() => setMode("signin")}
          data-testid="login-tab-signin"
        >
          Log in
        </button>
        <button
          type="button"
          aria-pressed={mode === "signup"}
          className={`button button--sm ${mode === "signup" ? "button--primary" : "button--secondary"}`}
          onClick={() => setMode("signup")}
          data-testid="login-tab-signup"
        >
          Sign up
        </button>
      </div>

      {confirmationSent ? (
        <div className="alert alert--success" role="status" data-testid="signup-confirm">
          Check your email. Open the confirmation link from <strong>{email}</strong> to finish
          creating your account. The link brings you back here.
        </div>
      ) : (
        <form onSubmit={handleSubmit} aria-describedby={error ? errorId : undefined}>
          <label htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            data-testid="login-email-input"
          />
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={mode === "signup" ? 8 : 6}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            data-testid="login-password-input"
          />
          {mode === "signup" && <p className="cloud-muted">Use at least 8 characters.</p>}
          {error && (
            <p id={errorId} className="auth-form-error" role="alert" data-testid="login-error">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="button button--primary"
            disabled={submitting}
            data-testid="login-submit"
          >
            {mode === "signin" ? "Log in" : "Sign up"}
          </button>
        </form>
      )}

      {mode === "signin" ? (
        <p>
          <Link to="/forgot-password" data-testid="forgot-password-link">
            Forgot your password?
          </Link>
        </p>
      ) : (
        <p className="cloud-muted">
          By signing up you agree to the <Link to="/docs/legal/terms">terms of service</Link> and
          the <Link to="/docs/legal/privacy">privacy policy</Link>.
        </p>
      )}

      <div className="auth-divider" role="separator">
        <span>or</span>
      </div>
      <OAuthButtons next={next} onError={setError} />
      <p className="cloud-muted">
        {mode === "signin" ? (
          <>
            New to ixtable? <Link to={`/signup${nextQuery}`}>Create an account</Link>
          </>
        ) : (
          <>
            Already have an account? <Link to={`/login${nextQuery}`}>Log in</Link>
          </>
        )}
      </p>
    </div>
  );
}
