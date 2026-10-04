import React, { useEffect, useState, type ReactNode } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import { useHistory, useLocation } from "@docusaurus/router";
import { useAuth } from "@site/src/contexts/AuthContext";
import { safeNext } from "@site/src/lib/cloud";

function readCallbackError(search: string, hash: string): string | null {
  for (const raw of [search, hash.replace(/^#/, "?")]) {
    const params = new URLSearchParams(raw);
    const description = params.get("error_description") ?? params.get("error");
    if (description) return description.replace(/\+/g, " ");
  }
  return null;
}

/**
 * Landing page for OAuth sign-in (Google, Microsoft) and email confirmation links.
 * supabase-js reads the session from the URL when the client starts; this page waits for
 * that, then continues to `next`.
 */
export default function AuthCallbackPage(): ReactNode {
  const { user, loading } = useAuth();
  const history = useHistory();
  const location = useLocation();
  const next = safeNext(new URLSearchParams(location.search).get("next"));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(readCallbackError(location.search, location.hash));
  }, [location.search, location.hash]);

  useEffect(() => {
    if (!loading && user) history.replace(next);
  }, [loading, user, history, next]);

  return (
    <Layout title="Signing in" description="Completing sign-in">
      <div className="auth-form">
        <h1>Signing you in</h1>
        {error ? (
          <div className="alert alert--danger" role="alert" data-testid="auth-callback-error">
            <p>Sign-in did not complete: {error}</p>
            <Link to={`/login?next=${encodeURIComponent(next)}`}>Back to log in</Link>
          </div>
        ) : !loading && !user ? (
          <div className="alert alert--warning" role="status" data-testid="auth-callback-nosession">
            <p>This sign-in or confirmation link is invalid or has expired.</p>
            <Link to={`/login?next=${encodeURIComponent(next)}`}>Log in</Link>
          </div>
        ) : (
          <p role="status" aria-live="polite">
            Finishing sign-in...
          </p>
        )}
      </div>
    </Layout>
  );
}
