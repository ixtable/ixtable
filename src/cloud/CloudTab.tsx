import { useCallback, useEffect, useState } from "react";
import { useDocumentConfig } from "../lib/config-store";
import { AccountLine, SignInPanel } from "./auth";
import { useCloudSession } from "./useCloudSession";
import { getApp } from "./client";
import { CloudErrorNotice } from "./CloudErrorNotice";
import { type CloudError, toCloudError } from "./errors";
import { PublishPanel } from "./PublishPanel";
import { CredentialsPanel, LinkPanel, RolesPanel } from "./StudioPanels";
import type { CloudApp } from "./types";
import { VersionsPanel } from "./VersionsPanel";
import "./cloud.css";

/**
 * Settings → Cloud (Studio): sign in, link the document to a cloud
 * application, sync roles, deliver credentials, publish checkpoints, and
 * browse, restore, or back up versions (PRD §5 steps 8–9, 14; §22–§23).
 */
export function CloudTab() {
  const { session, ready } = useCloudSession();
  const { config } = useDocumentConfig();
  const link = config.cloud ?? null;
  const appId = link?.appId;
  const userId = session?.user.id;
  const [app, setApp] = useState<CloudApp | null>(null);
  const [error, setError] = useState<CloudError | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);

  useEffect(() => {
    if (!userId || !appId) {
      setApp(null);
      return;
    }
    let active = true;
    getApp(appId)
      .then((next) => {
        if (!active) return;
        setApp(next);
        setError(null);
      })
      .catch(async (reason) => {
        if (active) setError(await toCloudError(reason));
      });
    return () => {
      active = false;
    };
  }, [userId, appId, revision]);

  if (!ready)
    return (
      <p className="cloud-muted" role="status">
        Checking cloud sign-in…
      </p>
    );
  if (!session)
    return (
      <div className="cloud-panel">
        <SignInPanel purpose="Sign in to publish this application to its runtime users." />
      </div>
    );
  return (
    <div className="cloud-panel">
      <AccountLine email={session.user.email ?? session.user.id} />
      {error && <CloudErrorNotice error={error} />}
      {!link ? (
        <LinkPanel />
      ) : (
        <>
          <section className="cloud-card" aria-label="Cloud application">
            <h2>{app?.name ?? "Cloud application"}</h2>
            <p className="cloud-muted">
              Application id <code>{link.appId}</code>
              {app && app.ownerId !== session.user.id && " · you are not this application's owner"}
            </p>
          </section>
          <RolesPanel appId={link.appId} />
          {config.datasource?.kind === "postgres" && <CredentialsPanel appId={link.appId} />}
          <PublishPanel app={app} onPublished={refresh} />
          <VersionsPanel app={app} revision={revision} />
        </>
      )}
    </div>
  );
}
