import React, { type ReactNode } from "react";
import Link from "@docusaurus/Link";
import {
  ARCHIVE_LIMIT_BYTES,
  formatBytes,
  useCloudApi,
  type AppVersion,
  type CloudApp,
  type Entitlement,
  type Subscription,
} from "@site/src/lib/cloud";
import { entitlementStatus } from "@site/src/lib/cloud/status";
import { Badge, Empty, ErrorNotice, Loading, TableWrap } from "../ui";
import { useAsync } from "../useAsync";

/** Apps with plan, seat usage, and archive size. Entitlement comes from app_entitlement(). */
export default function AppsTable({ apps }: { apps: CloudApp[] }): ReactNode {
  const api = useCloudApi();
  const ids = apps.map((app) => app.id);
  const details = useAsync(async () => {
    const q = api.q();
    const [plans, subscriptions, latest, entitlements] = await Promise.all([
      q.plans().catch(() => []),
      q.subscriptions(ids).catch((): Record<string, Subscription> => ({})),
      q.latestVersions(ids).catch((): Record<string, AppVersion> => ({})),
      Promise.all(ids.map((id) => q.entitlement(id).catch(() => null))),
    ]);
    const byApp: Record<string, Entitlement | null> = {};
    ids.forEach((id, index) => {
      byApp[id] = entitlements[index];
    });
    return { plans, subscriptions, latest, entitlements: byApp };
  }, [api, ids.join(",")]);

  if (apps.length === 0) {
    return (
      <Empty>
        No cloud apps yet. Cloud apps are created from the desktop app: open the project in Studio
        and publish it from the Cloud tab in Settings.
      </Empty>
    );
  }
  if (details.loading && !details.data) return <Loading label="Loading apps" />;
  const data = details.data;
  return (
    <>
      <ErrorNotice error={details.error} />
      <TableWrap label="Cloud apps">
        <thead>
          <tr>
            <th scope="col">App</th>
            <th scope="col">Status</th>
            <th scope="col">Plan</th>
            <th scope="col">Runtime users</th>
            <th scope="col">Archive size</th>
            <th scope="col">Latest version</th>
          </tr>
        </thead>
        <tbody>
          {apps.map((app) => {
            const entitlement = data?.entitlements[app.id];
            const status = entitlementStatus(entitlement);
            const subscription = data?.subscriptions[app.id];
            const plan = data?.plans.find((row) => row.id === subscription?.plan_id);
            const latest = data?.latest[app.id];
            const size = latest?.archive_size ?? 0;
            return (
              <tr key={app.id}>
                <th scope="row">
                  <Link to={`/cloud/app?id=${app.id}`}>{app.name}</Link>
                  <div className="cloud-muted">
                    {app.datasource_kind === "postgres" ? "PostgreSQL" : "SQLite"}
                  </div>
                </th>
                <td>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </td>
                <td>{plan?.name ?? "None"}</td>
                <td>
                  {entitlement ? `${entitlement.used} of ${entitlement.allowance}` : "Unknown"}
                </td>
                <td>
                  {latest ? (
                    <>
                      <meter
                        className="cloud-meter"
                        min={0}
                        max={ARCHIVE_LIMIT_BYTES}
                        high={ARCHIVE_LIMIT_BYTES * 0.8}
                        value={size}
                        aria-label={`${app.name} archive size`}
                      />{" "}
                      {formatBytes(size)} of 500 MB
                    </>
                  ) : (
                    "Not published"
                  )}
                </td>
                <td>{latest?.version ?? "None"}</td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
    </>
  );
}
