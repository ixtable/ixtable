import React, { useState, type ReactNode } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import { useLocation } from "@docusaurus/router";
import { useAuth } from "@site/src/contexts/AuthContext";
import { Loading, Notice } from "@site/src/components/cloud/ui";
import { useAction } from "@site/src/components/cloud/useAsync";
import { useCloudApi, type CloudError, type FunctionMap } from "@site/src/lib/cloud";

type Membership = FunctionMap["invitations-accept"]["out"]["membership"];

/** Classifies an accept failure. Servers may report expiry and reuse as VALIDATION with a message. */
function inviteProblem(error: CloudError): { title: string; body: string } {
  const detail = (error.detail ?? "").toLowerCase();
  if (error.code === "EXPIRED" || detail.includes("expired")) {
    return {
      title: "This invitation has expired",
      body: "Invitations are valid for a limited time. Ask the person who invited you to send a new one.",
    };
  }
  if (detail.includes("revoked")) {
    return {
      title: "This invitation was withdrawn",
      body: "The sender withdrew this invitation or sent a newer one. Use the newest invitation email, or ask for a new one.",
    };
  }
  if (error.code === "ALREADY_USED" || detail.includes("already")) {
    return {
      title: "This invitation was already used",
      body: "Each invitation works once. If you accepted it earlier, the app or organization is already in your Cloud dashboard.",
    };
  }
  if (
    error.code === "ALLOWANCE_EXCEEDED" ||
    error.code === "ENTITLEMENT_REQUIRED" ||
    detail.includes("allowance")
  ) {
    return {
      title: "This app has no free runtime user seats",
      body: "The app's plan does not allow another runtime user, or the subscription is not active. The app owner must upgrade the plan in the Cloud dashboard. Your invitation stays valid until it expires, so try again after they upgrade.",
    };
  }
  if (error.code === "FORBIDDEN" && detail.includes("verify")) {
    return {
      title: "Confirm your email address first",
      body: "Open the confirmation link ixtable sent when you signed up, then open this invitation again.",
    };
  }
  if (error.code === "FORBIDDEN") {
    return {
      title: "This invitation is for a different account",
      body: "Sign in with the email address the invitation was sent to, then open the link again.",
    };
  }
  if (error.code === "NOT_FOUND") {
    return {
      title: "Invitation not found",
      body: "The link is incomplete or the invitation was withdrawn. Ask the sender for a new one.",
    };
  }
  return { title: "The invitation could not be accepted", body: error.message };
}

function AcceptInvitation({ token, email }: { token: string; email: string }): ReactNode {
  const api = useCloudApi();
  const [membership, setMembership] = useState<Membership | null>(null);
  const accept = useAction(async () => {
    const result = await api.call("invitations-accept", { token });
    setMembership(result.membership);
  });

  if (membership) {
    const isApp = membership.kind === "app";
    return (
      <Notice tone="success" title="Invitation accepted" testId="invite-accepted">
        {isApp ? (
          <p>
            You are now a runtime user of this app. Open the ixtable desktop app, sign in as {email}
            , and choose <em>Cloud apps</em> to install it.
          </p>
        ) : (
          <p>You joined the organization.</p>
        )}
        <Link className="button button--primary" to="/cloud">
          Open the Cloud dashboard
        </Link>
      </Notice>
    );
  }
  const problem = accept.error ? inviteProblem(accept.error) : null;
  return (
    <>
      <p>
        You are signed in as <strong>{email}</strong>. Accepting adds this account to the
        organization or app that invited you.
      </p>
      {problem && (
        <Notice tone="danger" title={problem.title} testId="invite-error">
          {problem.body}
        </Notice>
      )}
      <button
        type="button"
        className="button button--primary"
        disabled={accept.pending}
        onClick={() => accept.run()}
      >
        {accept.pending ? "Accepting..." : "Accept invitation"}
      </button>
    </>
  );
}

export default function InvitePage(): ReactNode {
  const { user, loading } = useAuth();
  const location = useLocation();
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const next = encodeURIComponent(`/invite?token=${encodeURIComponent(token)}`);

  let body: ReactNode;
  if (!token) {
    body = (
      <Notice tone="danger" title="This invitation link is incomplete" testId="invite-error">
        Open the full link from the invitation email.
      </Notice>
    );
  } else if (loading) {
    body = <Loading label="Checking your session" />;
  } else if (!user) {
    body = (
      <>
        <p>
          Log in or create an account with the email address the invitation was sent to. You come
          back to this page afterwards.
        </p>
        <div className="cloud-actions">
          <Link className="button button--primary" to={`/login?next=${next}`}>
            Log in to accept
          </Link>
          <Link className="button button--secondary" to={`/signup?next=${next}`}>
            Create an account
          </Link>
        </div>
      </>
    );
  } else {
    body = <AcceptInvitation token={token} email={user.email ?? user.id} />;
  }

  return (
    <Layout title="Accept invitation" description="Accept an ixtable Cloud invitation">
      <main className="cloud-page cloud-page--narrow">
        <h1>Accept invitation</h1>
        {body}
      </main>
    </Layout>
  );
}
