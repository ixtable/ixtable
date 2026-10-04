import React, { useId, useState, type FormEvent, type ReactNode } from "react";
import { useHistory, useLocation } from "@docusaurus/router";
import type { User } from "@supabase/supabase-js";
import { useCloudApi } from "@site/src/lib/cloud";
import { Empty, ErrorNotice, Loading, Section } from "../ui";
import { useAction, useAsync } from "../useAsync";
import AppsTable from "./AppsTable";
import OrgMembers from "./OrgMembers";

function CreateOrgForm({
  userId,
  onCreated,
}: {
  userId: string;
  onCreated: (id: string) => void;
}): ReactNode {
  const api = useCloudApi();
  const inputId = useId();
  const [name, setName] = useState("");
  const create = useAction(async () => {
    const org = await api.q().createOrganization(name.trim(), userId);
    setName("");
    onCreated(org.id);
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.run();
  };
  return (
    <form className="cloud-inline-form" onSubmit={submit} aria-label="Create organization">
      <div className="cloud-field">
        <label htmlFor={inputId}>New organization name</label>
        <input
          id={inputId}
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <button
        type="submit"
        className="button button--primary"
        disabled={create.pending || !name.trim()}
      >
        Create organization
      </button>
      <ErrorNotice error={create.error} />
    </form>
  );
}

/** /cloud: organizations, their apps and members, and apps shared with the user. */
export default function CloudHome({ user }: { user: User }): ReactNode {
  const api = useCloudApi();
  const history = useHistory();
  const location = useLocation();
  const selectId = useId();
  const requested = new URLSearchParams(location.search).get("org");
  const state = useAsync(async () => {
    const q = api.q();
    const [orgs, apps] = await Promise.all([q.organizations(), q.apps()]);
    return { orgs, apps };
  }, [api]);

  const select = (id: string) => history.replace(`/cloud?org=${id}`);
  const created = (id: string) => {
    state.reload();
    select(id);
  };

  if (state.loading && !state.data) return <Loading label="Loading your organizations" />;
  if (state.error) return <ErrorNotice error={state.error} />;
  const { orgs, apps } = state.data ?? { orgs: [], apps: [] };
  const org = orgs.find((row) => row.id === requested) ?? orgs[0];
  const orgIds = new Set(orgs.map((row) => row.id));
  const shared = apps.filter((app) => !orgIds.has(app.org_id));

  return (
    <>
      <div className="cloud-header">
        <div>
          <h1>Cloud dashboard</h1>
          <p className="cloud-muted">
            Signed in as {user.email}. Cloud apps are private: only people you invite can install
            them.
          </p>
        </div>
        {orgs.length > 1 && org && (
          <div className="cloud-field">
            <label htmlFor={selectId}>Organization</label>
            <select id={selectId} value={org.id} onChange={(event) => select(event.target.value)}>
              {orgs.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {org ? (
        <>
          <Section
            title={`${org.name} apps`}
            description="Each cloud app has its own plan and runtime user allowance."
          >
            <AppsTable apps={apps.filter((app) => app.org_id === org.id)} />
          </Section>
          <OrgMembers org={org} userId={user.id} />
        </>
      ) : (
        <Section
          title="Organizations"
          description="An organization owns cloud apps and their billing."
        >
          <Empty>You are not in an organization yet. Create one to publish cloud apps.</Empty>
        </Section>
      )}

      {shared.length > 0 && (
        <Section
          title="Apps shared with you"
          description="You are a runtime user of these apps. Install them from the desktop app."
        >
          <ul>
            {shared.map((app) => (
              <li key={app.id}>{app.name}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="New organization">
        <CreateOrgForm userId={user.id} onCreated={created} />
      </Section>
    </>
  );
}
