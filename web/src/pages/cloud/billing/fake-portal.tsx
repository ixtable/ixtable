import React, { type ReactNode } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import { useLocation } from "@docusaurus/router";
import { Notice } from "@site/src/components/cloud/ui";

/** Billing portal of the local "fake" billing provider. Real stacks redirect to Stripe instead. */
export default function FakePortalPage(): ReactNode {
  const appId = new URLSearchParams(useLocation().search).get("app") ?? "";
  return (
    <Layout title="Test billing portal">
      <main className="cloud-page cloud-page--narrow">
        <h1>Test billing portal</h1>
        <Notice tone="warning" title="Test billing provider">
          This environment does not use Stripe. In production this button opens the Stripe billing
          portal, where you update the payment method and download invoices.
        </Notice>
        <Link to={`/cloud/app?id=${appId}&tab=billing`}>Back to billing</Link>
      </main>
    </Layout>
  );
}
