import React, { type ReactNode } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import { useHistory } from "@docusaurus/router";
import { useAuth } from "@site/src/contexts/AuthContext";
import RequireAuth from "@site/src/components/cloud/RequireAuth";
import { DeleteAccountSection, ExportSection } from "@site/src/components/account/AccountData";
import {
  PasswordSection,
  ProfileSection,
  ProvidersSection,
} from "@site/src/components/account/AccountSections";

export default function AccountPage(): ReactNode {
  const { signOut } = useAuth();
  const history = useHistory();
  const handleSignOut = async () => {
    await signOut();
    history.replace("/login");
  };
  return (
    <Layout title="Account" description="Your ixtable account">
      <main className="cloud-page cloud-page--narrow">
        <RequireAuth>
          {(user) => (
            <>
              <div className="cloud-header">
                <h1>Account</h1>
                <div className="cloud-actions">
                  <Link className="button button--primary" to="/cloud">
                    Cloud dashboard
                  </Link>
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={handleSignOut}
                    data-testid="account-sign-out"
                  >
                    Sign out
                  </button>
                </div>
              </div>
              <ProfileSection user={user} />
              <PasswordSection />
              <ProvidersSection user={user} />
              <ExportSection />
              <DeleteAccountSection user={user} />
            </>
          )}
        </RequireAuth>
      </main>
    </Layout>
  );
}
