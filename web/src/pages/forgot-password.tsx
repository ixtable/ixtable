import React, { useState, type FormEvent, type ReactNode } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import { useAuth } from "@site/src/contexts/AuthContext";

export default function ForgotPasswordPage(): ReactNode {
  const { resetPasswordForEmail } = useAuth();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await resetPasswordForEmail(email);
    setSubmitting(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSubmitted(true);
  };

  return (
    <Layout title="Forgot password" description="Reset your password">
      <div className="auth-form">
        <h1>Reset your password</h1>
        {submitted ? (
          <p data-testid="reset-request-success">
            If an account exists for that email, a password reset link has been sent.
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
              data-testid="forgot-password-email-input"
            />
            {error && (
              <p className="auth-form-error" data-testid="forgot-password-error">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="button button--primary"
              disabled={submitting}
              data-testid="forgot-password-submit"
            >
              Send reset link
            </button>
          </form>
        )}
        <p>
          <Link to="/login">Back to log in</Link>
        </p>
      </div>
    </Layout>
  );
}
