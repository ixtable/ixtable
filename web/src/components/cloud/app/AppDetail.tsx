import React, { type ReactNode } from "react";
import Link from "@docusaurus/Link";
import { useHistory, useLocation } from "@docusaurus/router";
import type { User } from "@supabase/supabase-js";
import { useCloudApi } from "@site/src/lib/cloud";
import { entitlementStatus } from "@site/src/lib/cloud/status";
import { Badge, ErrorNotice, Loading, Notice, TabPanel, Tabs, type TabDef } from "../ui";
import { useAsync } from "../useAsync";
import AuditTab from "./AuditTab";
import BackupsTab from "./BackupsTab";
import BillingTab from "./BillingTab";
import CredentialsTab from "./CredentialsTab";
import InstallationsTab from "./InstallationsTab";
import OverviewTab from "./OverviewTab";
import RolesTab from "./RolesTab";
import SettingsTab from "./SettingsTab";
import type { AppTabProps } from "./types";
import UsersTab from "./UsersTab";
import VersionsTab from "./VersionsTab";

type Access = "all" | "admin" | "owner" | "billing";

const TABS: (TabDef & { access: Access; render: (props: AppTabProps) => ReactNode })[] = [
  { id: "overview", label: "Overview", access: "all", render: (p) => <OverviewTab {...p} /> },
  { id: "users", label: "Runtime users", access: "admin", render: (p) => <UsersTab {...p} /> },
  { id: "roles", label: "Roles", access: "admin", render: (p) => <RolesTab {...p} /> },
  { id: "versions", label: "Versions", access: "admin", render: (p) => <VersionsTab {...p} /> },
  { id: "backups", label: "Backups", access: "admin", render: (p) => <BackupsTab {...p} /> },
  {
    id: "installations",
    label: "Installations",
    access: "admin",
    render: (p) => <InstallationsTab {...p} />,
  },
  {
    id: "credentials",
    label: "Credentials",
    access: "owner",
    render: (p) => <CredentialsTab {...p} />,
  },
  { id: "audit", label: "Audit history", access: "admin", render: (p) => <AuditTab {...p} /> },
  { id: "billing", label: "Billing", access: "billing", render: (p) => <BillingTab {...p} /> },
  { id: "settings", label: "Settings", access: "admin", render: (p) => <SettingsTab {...p} /> },
];

function allowed(
  access: Access,
  props: Pick<AppTabProps, "isOwner" | "isAdmin" | "orgRole">,
): boolean {
  if (access === "all") return true;
  if (access === "owner") return props.isOwner;
  if (access === "billing") return props.isAdmin || props.orgRole === "billing";
  return props.isAdmin;
}

/** /cloud/app?id=…&tab=…: one cloud app. Tabs a viewer cannot use are hidden, and RLS still applies. */
export default function AppDetail({ user }: { user: User }): ReactNode {
  const api = useCloudApi();
  const history = useHistory();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const appId = params.get("id") ?? "";
  const state = useAsync(async () => {
    const q = api.q();
    const app = await q.app(appId);
    const [isAdmin, orgRole, profiles, entitlement] = await Promise.all([
      q.isAppAdmin(appId).catch(() => false),
      q.myOrgRole(app.org_id, user.id),
      q.profiles([app.owner_id]),
      q.entitlement(appId).catch(() => null),
    ]);
    return { app, isAdmin, orgRole, owner: profiles[app.owner_id] ?? null, entitlement };
  }, [api, appId, user.id]);

  if (!appId)
    return (
      <Notice tone="danger">
        No app selected. Open an app from the <Link to="/cloud">Cloud dashboard</Link>.
      </Notice>
    );
  if (state.loading && !state.data) return <Loading label="Loading app" />;
  if (state.error || !state.data) return <ErrorNotice error={state.error} testId="app-error" />;

  const { app, isAdmin, orgRole, owner, entitlement } = state.data;
  const props: AppTabProps = {
    app,
    user,
    isOwner: app.owner_id === user.id,
    isAdmin,
    orgRole,
    owner,
    entitlement,
    reloadApp: state.reload,
  };
  const tabs = TABS.filter((tab) => allowed(tab.access, props));
  const selected = tabs.find((tab) => tab.id === params.get("tab")) ?? tabs[0];
  const status = entitlementStatus(entitlement);
  const selectTab = (id: string) => history.replace(`/cloud/app?id=${app.id}&tab=${id}`);

  return (
    <>
      <nav aria-label="Breadcrumb" className="cloud-muted">
        <Link to={`/cloud?org=${app.org_id}`}>Cloud dashboard</Link> / {app.name}
      </nav>
      <div className="cloud-header">
        <h1>{app.name}</h1>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <Tabs tabs={tabs} selected={selected.id} onSelect={selectTab} label="App sections" />
      <TabPanel id={selected.id}>{selected.render(props)}</TabPanel>
    </>
  );
}
