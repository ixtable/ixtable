import React, { useState, type FormEvent, type ReactNode } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import { useHistory } from "@docusaurus/router";
import { useAuth } from "@site/src/contexts/AuthContext";

export default function ResetPasswordPage(): ReactNode {
  const { updatePassword, signOut, user, loading } = useAuth();
  const history = useHistory();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await updatePassword(password);
    if (result.error) {
      setSubmitting(false);
      setError(result.error);
      return;
    }
    // The recovery session stays signed in after a password update. Sign out
    // so the redirect to /login lands on an actual login form, and so the new
    // password is the one required to get back in.
    await signOut();
    setSubmitting(false);
    setSuccess(true);
    setTimeout(() => history.replace("/login"), 1500);
  };

  return (
    <Layout title="Set a new password" description="Choose a new password">
      <div className="auth-form">
        <h1>Choose a new password</h1>
        {!loading && !user && !success && (
          <p className="auth-form-error" data-testid="reset-password-no-session">
            This password reset link is invalid or has expired. Request a new one from the{" "}
            <Link to="/forgot-password">forgot password</Link> page.
          </p>
        )}
        {success ? (
          <p data-testid="reset-password-success">Password updated. Redirecting to log in...</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <label htmlFor="password">New password</label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="reset-password-input"
            />
            {error && (
              <p className="auth-form-error" data-testid="reset-password-error">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="button button--primary"
              disabled={submitting}
              data-testid="reset-password-submit"
            >
              Update password
            </button>
          </form>
        )}
      </div>
    </Layout>
  );
}
