import React, { useId, useState, type FormEvent, type ReactNode } from "react";
import Layout from "@theme/Layout";
import type { User } from "@supabase/supabase-js";
import RequireAuth from "@site/src/components/cloud/RequireAuth";
import { ErrorNotice, Loading, Notice } from "@site/src/components/cloud/ui";
import { useAction, useAsync } from "@site/src/components/cloud/useAsync";
import { useCloudApi } from "@site/src/lib/cloud";
import { redactSecrets } from "@site/src/lib/cloud/redact";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function SupportConsole(): ReactNode {
  const api = useCloudApi();
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const lookup = useAction(async () => {
    const value = query.trim();
    const input = UUID.test(value) ? { appId: value } : { email: value.toLowerCase() };
    const { diagnostics } = await api.call("admin-support", { query: input });
    setResult(redactSecrets(diagnostics));
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setResult(null);
    lookup.run();
  };
  return (
    <>
      <p className="cloud-muted">
        Diagnose distribution and key-grant failures. Results never include credentials, keys, or
        tokens.
      </p>
      <form className="cloud-inline-form" onSubmit={submit} aria-label="Support lookup">
        <div className="cloud-field">
          <label htmlFor={inputId}>User email or app id</label>
          <input
            id={inputId}
            required
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button type="submit" className="button button--primary" disabled={lookup.pending}>
          {lookup.pending ? "Looking up..." : "Look up"}
        </button>
      </form>
      <ErrorNotice error={lookup.error} />
      {result !== null && (
        <section aria-label="Diagnostics">
          <h2>Diagnostics</h2>
          <pre className="cloud-code" data-testid="support-diagnostics">
            {JSON.stringify(result, null, 2)}
          </pre>
        </section>
      )}
    </>
  );
}

function OperatorGate({ user }: { user: User }): ReactNode {
  const api = useCloudApi();
  const profile = useAsync(() => api.q().myProfile(user.id), [api, user.id]);
  if (profile.loading) return <Loading />;
  if (!profile.data?.is_operator) {
    return (
      <Notice tone="warning" title="Page not available" testId="support-denied">
        This page is for ixtable support operators.
      </Notice>
    );
  }
  return <SupportConsole />;
}

export default function AdminSupportPage(): ReactNode {
  return (
    <Layout title="Support" description="ixtable Cloud support tools">
      <main className="cloud-page">
        <h1>Support lookup</h1>
        <RequireAuth>{(user) => <OperatorGate user={user} />}</RequireAuth>
      </main>
    </Layout>
  );
}
