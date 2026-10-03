import React, { type ReactNode } from "react";
import Layout from "@theme/Layout";
import RequireAuth from "@site/src/components/cloud/RequireAuth";
import AppDetail from "@site/src/components/cloud/app/AppDetail";

export default function CloudAppPage(): ReactNode {
  return (
    <Layout title="Cloud app" description="Manage an ixtable Cloud app">
      <main className="cloud-page">
        <RequireAuth>{(user) => <AppDetail user={user} />}</RequireAuth>
      </main>
    </Layout>
  );
}
