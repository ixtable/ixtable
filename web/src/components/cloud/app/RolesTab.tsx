import React, { type ReactNode } from "react";
import { formatDate, useCloudApi, type AppRole, type ObjectPermission } from "@site/src/lib/cloud";
import { Empty, ErrorNotice, Loading, Notice, Section, TableWrap } from "../ui";
import { useAsync } from "../useAsync";
import type { AppTabProps } from "./types";

const OPS = ["read", "create", "update", "delete"] as const;

function mark(value: boolean | undefined): string {
  return value ? "Yes" : "No";
}

function ObjectMatrix({ role }: { role: AppRole }): ReactNode {
  const objects: ObjectPermission[] = role.permissions.objects ?? [];
  if (objects.length === 0) return <p className="cloud-muted">No object access.</p>;
  return (
    <TableWrap label={`${role.name} object permissions`}>
      <thead>
        <tr>
          <th scope="col">Object</th>
          <th scope="col">Kind</th>
          {OPS.map((op) => (
            <th key={op} scope="col">
              {op[0].toUpperCase() + op.slice(1)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {objects.map((object) => (
          <tr key={`${object.kind}:${object.id}`}>
            <th scope="row" className="cloud-code">
              {object.name ?? object.id}
            </th>
            <td>{object.kind}</td>
            {OPS.map((op) => (
              <td key={op}>{mark(object[op])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

/** Read-only view of roles synced from Studio. Edit roles in Studio and publish to change them. */
export default function RolesTab({ app }: AppTabProps): ReactNode {
  const api = useCloudApi();
  const state = useAsync(() => api.q().roles(app.id), [api, app.id]);
  if (state.loading && !state.data) return <Loading label="Loading roles" />;
  return (
    <>
      <Notice tone="info" title="Roles come from Studio">
        Runtime roles are defined in the desktop app and sync here when you publish. This page is
        read-only.
      </Notice>
      <Notice tone="warning" title="What runtime roles enforce" testId="roles-limitation">
        The Runtime applies these roles to navigation, queries, forms, reports, dashboards, and
        actions. For an app that connects straight to PostgreSQL, roles do not protect against an
        authorized user who extracts the database credentials. For database-level isolation, give
        each user separate least-privileged credentials and database permissions.
      </Notice>
      <ErrorNotice error={state.error} />
      {state.data?.length === 0 && <Empty>No roles synced yet.</Empty>}
      {state.data?.map((role) => (
        <Section
          key={role.id}
          title={role.name}
          description={`Last synced ${formatDate(role.updated_at)}`}
        >
          <dl className="cloud-dl">
            <dt>Navigation items</dt>
            <dd>
              {role.permissions.navigation?.length
                ? role.permissions.navigation.join(", ")
                : "None"}
            </dd>
            <dt>Actions</dt>
            <dd>
              {role.permissions.actions?.length ? role.permissions.actions.join(", ") : "None"}
            </dd>
          </dl>
          <ObjectMatrix role={role} />
        </Section>
      ))}
    </>
  );
}
