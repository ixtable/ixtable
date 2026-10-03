import React, { useEffect, type ReactNode } from "react";
import { useHistory, useLocation } from "@docusaurus/router";
import type { User } from "@supabase/supabase-js";
import { useAuth } from "@site/src/contexts/AuthContext";
import { Loading } from "./ui";

/**
 * Auth wall for cloud pages. Signed-out visitors go to /login with `next` set to the
 * current path and query, so they return here after signing in.
 */
export default function RequireAuth({
  children,
}: {
  children: (user: User) => ReactNode;
}): ReactNode {
  const { user, loading } = useAuth();
  const history = useHistory();
  const location = useLocation();

  useEffect(() => {
    if (!loading && !user) {
      const next = `${location.pathname}${location.search}`;
      // /account is the default destination after sign-in, so it needs no `next`.
      history.replace(next === "/account" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
    }
  }, [loading, user, history, location.pathname, location.search]);

  if (loading || !user) {
    return (
      <div className="cloud-page">
        <Loading label="Checking your session" />
      </div>
    );
  }
  return <>{children(user)}</>;
}
