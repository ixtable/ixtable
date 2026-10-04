import React, { useState, type ReactNode } from "react";
import Layout from "@theme/Layout";
import { useLocation } from "@docusaurus/router";
import RequireAuth from "@site/src/components/cloud/RequireAuth";
import { ErrorNotice, Notice } from "@site/src/components/cloud/ui";
import { useAction } from "@site/src/components/cloud/useAsync";
import { useCloudApi } from "@site/src/lib/cloud";

// RFC 7636: an S256 code challenge is 43 base64url characters.
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STATE_PATTERN = /^[A-Za-z0-9_.~-]{16,200}$/;

type Outcome = "pending" | "approved" | "denied";

function DesktopAuthRequest({ email }: { email: string }): ReactNode {
  const api = useCloudApi();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const codeChallenge = params.get("code_challenge") ?? "";
  const state = params.get("state") ?? "";
  const device = params.get("device") ?? params.get("device_name");
  const client = params.get("client") ?? params.get("app_version");
  const [outcome, setOutcome] = useState<Outcome>("pending");
  const approve = useAction(async () => {
    await api.call("desktop-auth-approve", { codeChallenge, state });
    setOutcome("approved");
  });

  const method = params.get("code_challenge_method") ?? "S256";
  if (!CHALLENGE_PATTERN.test(codeChallenge) || !STATE_PATTERN.test(state) || method !== "S256") {
    return (
      <Notice tone="danger" title="This sign-in link is incomplete" testId="desktop-auth-invalid">
        Start sign-in again from the ixtable desktop app. It opens this page with the details it
        needs.
      </Notice>
    );
  }
  if (outcome === "approved") {
    return (
      <Notice tone="success" title="Desktop sign-in approved" testId="desktop-auth-approved">
        Return to the ixtable desktop app. It finishes signing in within a few seconds. You can
        close this tab.
      </Notice>
    );
  }
  if (outcome === "denied") {
    return (
      <Notice tone="warning" title="Request denied" testId="desktop-auth-denied">
        The desktop app was not signed in. If you did not start this request, change your password
        from your account page.
      </Notice>
    );
  }
  return (
    <>
      <p>
        The ixtable desktop app is asking to sign in as{" "}
        <strong data-testid="desktop-auth-email">{email}</strong>.
      </p>
      <dl className="cloud-dl" aria-label="Sign-in request details">
        <dt>Device</dt>
        <dd>{device ?? "Not reported"}</dd>
        <dt>App version</dt>
        <dd>{client ?? "Not reported"}</dd>
        <dt>Request code</dt>
        <dd>
          <code>{state.slice(0, 8)}</code>
        </dd>
      </dl>
      <p className="cloud-muted">
        The desktop app reports the device and version. ixtable cannot verify them.
      </p>
      <Notice tone="warning" title="Approve only a sign-in you just started on your own computer">
        Someone can send you this page to trick you into signing in their copy of ixtable. Approve
        only if you just chose to sign in from the ixtable desktop app on your own computer.
        Approving gives that app a session for your account. It can then download every cloud app
        you can access and request their datasource keys. If you did not start this, choose Deny.
      </Notice>
      <ErrorNotice error={approve.error} testId="desktop-auth-error" />
      <div className="cloud-actions">
        <button
          type="button"
          className="button button--primary"
          disabled={approve.pending}
          onClick={() => approve.run()}
        >
          {approve.pending ? "Approving..." : "Approve sign-in"}
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={approve.pending}
          onClick={() => setOutcome("denied")}
        >
          Deny
        </button>
      </div>
    </>
  );
}

export default function DesktopAuthPage(): ReactNode {
  return (
    <Layout
      title="Approve desktop sign-in"
      description="Approve a sign-in request from the ixtable desktop app"
    >
      <main className="cloud-page cloud-page--narrow">
        <h1>Approve desktop sign-in</h1>
        <RequireAuth>{(user) => <DesktopAuthRequest email={user.email ?? user.id} />}</RequireAuth>
      </main>
    </Layout>
  );
}
