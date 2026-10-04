import React, { useState, type ReactNode } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import { useLocation } from "@docusaurus/router";
import RequireAuth from "@site/src/components/cloud/RequireAuth";
import { ErrorNotice, Notice } from "@site/src/components/cloud/ui";
import { useAction } from "@site/src/components/cloud/useAsync";
import { useCloudApi } from "@site/src/lib/cloud";

/**
 * Checkout page of the local "fake" billing provider (BILLING_PROVIDER=fake). Only local and QA
 * stacks link here. No payment details are collected.
 */
function FakeCheckout(): ReactNode {
  const api = useCloudApi();
  const params = new URLSearchParams(useLocation().search);
  const sessionId = params.get("session") ?? "";
  const appId = params.get("app") ?? "";
  const planId = params.get("plan") ?? "";
  const [done, setDone] = useState(false);
  const complete = useAction(async () => {
    await api.call("billing-fake-complete", { sessionId, appId, planId });
    setDone(true);
  });
  return (
    <>
      <Notice tone="warning" title="Test checkout">
        This environment uses the test billing provider. No card is charged and no payment details
        are collected.
      </Notice>
      <dl className="cloud-dl">
        <dt>Plan</dt>
        <dd>{planId}</dd>
        <dt>App id</dt>
        <dd className="cloud-code">{appId}</dd>
        <dt>Session</dt>
        <dd className="cloud-code">{sessionId}</dd>
      </dl>
      <ErrorNotice error={complete.error} />
      {done ? (
        <Notice tone="success" title="Test payment completed" testId="fake-checkout-done">
          The subscription activates when the billing webhook is processed.
        </Notice>
      ) : (
        <button
          type="button"
          className="button button--primary"
          disabled={complete.pending || !sessionId}
          onClick={() => complete.run()}
        >
          Complete test payment
        </button>
      )}
      <p>
        <Link to={`/cloud/app?id=${appId}&tab=billing`}>Back to billing</Link>
      </p>
    </>
  );
}

export default function FakeCheckoutPage(): ReactNode {
  return (
    <Layout title="Test checkout">
      <main className="cloud-page cloud-page--narrow">
        <h1>Test checkout</h1>
        <RequireAuth>{() => <FakeCheckout />}</RequireAuth>
      </main>
    </Layout>
  );
}
