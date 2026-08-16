import React, { useEffect, type ReactNode } from "react";
import Layout from "@theme/Layout";
import { useHistory } from "@docusaurus/router";
import { useAuth } from "@site/src/contexts/AuthContext";

export default function AccountPage(): ReactNode {
  const { user, loading, signOut } = useAuth();
  const history = useHistory();

  useEffect(() => {
    if (!loading && !user) {
      history.replace("/login");
    }
  }, [loading, user, history]);

  const handleSignOut = async () => {
    await signOut();
    history.replace("/login");
  };

  if (loading || !user) {
    return (
      <Layout title="Account">
        <div className="auth-form">
          <p data-testid="account-loading">Loading...</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="Account" description="Your account">
      <div className="auth-form">
        <h1>Account</h1>
        <p data-testid="account-email">{user.email}</p>
        <p data-testid="account-user-id">{user.id}</p>
        <button
          type="button"
          className="button button--secondary"
          onClick={handleSignOut}
          data-testid="account-sign-out"
        >
          Sign out
        </button>
      </div>
    </Layout>
  );
}
