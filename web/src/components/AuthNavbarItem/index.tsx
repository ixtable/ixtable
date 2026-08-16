import React, { type ReactNode } from "react";
import Link from "@docusaurus/Link";
import { useAuth } from "@site/src/contexts/AuthContext";

export default function AuthNavbarItem(): ReactNode {
  const { user, loading } = useAuth();

  if (loading) {
    return <span className="navbar__item" data-testid="navbar-auth-loading" />;
  }

  if (user) {
    return (
      <Link className="navbar__item navbar__link" to="/account" data-testid="navbar-account-link">
        {user.email}
      </Link>
    );
  }

  return (
    <Link className="navbar__item navbar__link" to="/login" data-testid="navbar-login-link">
      Log in
    </Link>
  );
}
