import React, { useEffect, useState, type ReactNode } from "react";
import Link from "@docusaurus/Link";
import { useAuth } from "@site/src/contexts/AuthContext";
import { useCloudApi } from "@site/src/lib/cloud";

/** Navbar sign-in state. The Support link appears only for operators (profiles.is_operator). */
interface Props {
  /** Set by Docusaurus when the item renders in the mobile sidebar. */
  mobile?: boolean;
  onClick?: () => void;
}

function NavLink({
  to,
  mobile,
  onClick,
  testId,
  label,
  children,
}: {
  to: string;
  mobile?: boolean;
  onClick?: () => void;
  testId: string;
  label?: string;
  children: ReactNode;
}): ReactNode {
  if (mobile) {
    return (
      <li className="menu__list-item">
        <Link
          className="menu__link"
          to={to}
          onClick={onClick}
          aria-label={label}
          data-testid={testId}
        >
          {children}
        </Link>
      </li>
    );
  }
  return (
    <Link className="navbar__item navbar__link" to={to} aria-label={label} data-testid={testId}>
      {children}
    </Link>
  );
}

export default function AuthNavbarItem({ mobile, onClick }: Props): ReactNode {
  const { user, loading } = useAuth();
  const api = useCloudApi();
  const [operator, setOperator] = useState(false);

  useEffect(() => {
    if (!user) {
      setOperator(false);
      return;
    }
    let cancelled = false;
    api
      .q()
      .myProfile(user.id)
      .then((profile) => {
        if (!cancelled) setOperator(Boolean(profile?.is_operator));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, user]);

  if (loading) {
    return mobile ? null : <span className="navbar__item" data-testid="navbar-auth-loading" />;
  }

  if (user) {
    return (
      <>
        {operator && (
          <NavLink
            to="/admin/support"
            mobile={mobile}
            onClick={onClick}
            testId="navbar-support-link"
          >
            Support
          </NavLink>
        )}
        <NavLink
          to="/account"
          mobile={mobile}
          onClick={onClick}
          label={`Account (${user.email})`}
          testId="navbar-account-link"
        >
          {user.email}
        </NavLink>
      </>
    );
  }

  return (
    <NavLink to="/login" mobile={mobile} onClick={onClick} testId="navbar-login-link">
      Log in
    </NavLink>
  );
}
