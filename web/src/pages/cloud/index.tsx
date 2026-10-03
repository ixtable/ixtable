import React, { type ReactNode } from "react";
import Layout from "@theme/Layout";
import RequireAuth from "@site/src/components/cloud/RequireAuth";
import CloudHome from "@site/src/components/cloud/org/CloudHome";

export default function CloudPage(): ReactNode {
  return (
    <Layout title="Cloud dashboard" description="Manage ixtable Cloud organizations and apps">
      <main className="cloud-page">
        <RequireAuth>{(user) => <CloudHome user={user} />}</RequireAuth>
      </main>
    </Layout>
  );
}
