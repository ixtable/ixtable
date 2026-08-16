import React, { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import { useHistory } from "@docusaurus/router";
import { useAuth } from "@site/src/contexts/AuthContext";

type Mode = "signin" | "signup";

export default function LoginPage(): ReactNode {
  const { user, loading, signIn, signUp, signInWithOAuth, oauthEnabled } = useAuth();
  const history = useHistory();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signedUp, setSignedUp] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      history.replace("/account");
    }
  }, [loading, user, history]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const result =
      mode === "signin" ? await signIn(email, password) : await signUp(email, password);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (mode === "signup") {
      setSignedUp(true);
    }
  };

  const handleOAuth = async (provider: "github" | "google") => {
    setError(null);
    const result = await signInWithOAuth(provider);
    if (result.error) {
      setError(result.error);
    }
  };

  return (
    <Layout title="Log in" description="Sign in to your account">
      <div className="auth-form">
        <h1>{mode === "signin" ? "Log in" : "Create an account"}</h1>

        <div className="button-group" style={{ marginBottom: "1rem" }}>
          <button
            type="button"
            className={`button button--sm ${mode === "signin" ? "button--primary" : "button--secondary"}`}
            onClick={() => setMode("signin")}
            data-testid="login-tab-signin"
          >
            Log in
          </button>
          <button
            type="button"
            className={`button button--sm ${mode === "signup" ? "button--primary" : "button--secondary"}`}
            onClick={() => setMode("signup")}
            data-testid="login-tab-signup"
          >
            Sign up
          </button>
        </div>

        {signedUp ? (
          <p data-testid="signup-success">
            Account created. Check your email if confirmation is required, or log in now.
          </p>
        ) : (
          <form onSubmit={handleSubmit}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              data-testid="login-email-input"
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="login-password-input"
            />
            {error && (
              <p className="auth-form-error" data-testid="login-error">
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

        {mode === "signin" && (
          <p>
            <Link to="/forgot-password" data-testid="forgot-password-link">
              Forgot your password?
            </Link>
          </p>
        )}

        <hr />
        <p>Or continue with</p>
        <div className="button-group">
          <button
            type="button"
            className="button button--secondary"
            disabled={!oauthEnabled}
            title={oauthEnabled ? undefined : "OAuth is not configured for this environment"}
            onClick={() => handleOAuth("github")}
            data-testid="oauth-github-button"
          >
            GitHub
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={!oauthEnabled}
            title={oauthEnabled ? undefined : "OAuth is not configured for this environment"}
            onClick={() => handleOAuth("google")}
            data-testid="oauth-google-button"
          >
            Google
          </button>
        </div>
      </div>
    </Layout>
  );
}
