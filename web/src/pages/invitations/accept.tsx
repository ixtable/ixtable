import React, { useEffect, type ReactNode } from "react";
import Layout from "@theme/Layout";
import { useHistory, useLocation } from "@docusaurus/router";

/** Older invitation links point here. Forward them to /invite with the same query. */
export default function InvitationsAcceptRedirect(): ReactNode {
  const history = useHistory();
  const location = useLocation();
  useEffect(() => {
    history.replace(`/invite${location.search}`);
  }, [history, location.search]);
  return (
    <Layout title="Accept invitation">
      <main className="cloud-page cloud-page--narrow">
        <p role="status">Opening your invitation...</p>
      </main>
    </Layout>
  );
}
