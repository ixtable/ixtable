import React, { useState, type ReactNode } from "react";
import { useHistory } from "@docusaurus/router";
import {
  formatBytes,
  formatDate,
  shortId,
  useCloudApi,
  type AppVersion,
  type MigrationRef,
  type Profile,
} from "@site/src/lib/cloud";
import { Badge, ConfirmDialog, Empty, ErrorNotice, Loading, Notice, Section } from "../ui";
import { useAction, useAsync } from "../useAsync";
import RestoreDialog from "./RestoreDialog";
import type { AppTabProps } from "./types";

type Pending = { kind: "fork"; version: AppVersion } | null;

function migrationLabel(migration: MigrationRef | string): string {
  return typeof migration === "string" ? migration : (migration.name ?? migration.id);
}

function SecuritySummary({ version }: { version: AppVersion }): ReactNode {
  const security = version.security ?? {};
  const mode = String(security.credential_mode ?? security.credentialMode ?? "none");
  const tls = security.tls ?? true;
  const override = Boolean(
    security.insecure_override_confirmed ?? security.insecureOverrideConfirmed,
  );
  const sharedAck = Boolean(
    security.shared_credential_warning_acknowledged ?? security.sharedCredentialWarningAcknowledged,
  );
  return (
    <div className="cloud-actions">
      <Badge tone={mode === "shared" ? "warning" : "neutral"}>
        Credentials: {mode.replace("_", " ")}
      </Badge>
      {tls === false || override ? (
        <Badge tone="danger">Non-TLS override confirmed</Badge>
      ) : (
        <Badge tone="success">TLS required</Badge>
      )}
      {mode === "shared" && sharedAck && (
        <Badge tone="warning">Shared credential warning acknowledged</Badge>
      )}
    </div>
  );
}

function VersionCard({
  version,
  isHead,
  developer,
  canManage,
  canDownload,
  onAction,
  onDownload,
}: {
  version: AppVersion;
  isHead: boolean;
  developer: Profile | undefined;
  canManage: boolean;
  canDownload: boolean;
  onAction: (pending: Pending) => void;
  onDownload: (version: AppVersion) => void;
}): ReactNode {
  const migrations = (version.migrations ?? []) as (MigrationRef | string)[];
  const tone =
    version.status === "published"
      ? "success"
      : version.status === "withdrawn"
        ? "danger"
        : "neutral";
  return (
    <article className="cloud-section" aria-label={`Version ${version.version}`}>
      <div className="cloud-section__head">
        <h3>
          Version {version.version} {isHead && <Badge tone="info">Head</Badge>}{" "}
          <Badge tone={tone}>{version.status}</Badge>
          {version.resolution && <Badge>{version.resolution}</Badge>}
        </h3>
        {canManage && (
          <div className="cloud-section__actions">
            {canDownload && (
              <button
                type="button"
                className="button button--sm button--secondary"
                onClick={() => onDownload(version)}
              >
                Download or restore {version.version}
              </button>
            )}
            {version.status === "published" && (
              <button
                type="button"
                className="button button--sm button--secondary"
                onClick={() => onAction({ kind: "fork", version })}
              >
                Fork {version.version} into a new app
              </button>
            )}
          </div>
        )}
      </div>
      <dl className="cloud-dl">
        <dt>Developer</dt>
        <dd>{developer?.email || shortId(version.developer_id)}</dd>
        <dt>Published</dt>
        <dd>{formatDate(version.published_at ?? version.created_at)}</dd>
        <dt>Checksum</dt>
        <dd className="cloud-code">sha256:{version.archive_sha256}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(version.archive_size)}</dd>
        <dt>Migrations</dt>
        <dd>{migrations.length ? migrations.map(migrationLabel).join(", ") : "None"}</dd>
        <dt>Minimum Runtime</dt>
        <dd>{version.min_runtime_version || "Any"}</dd>
        <dt>Security</dt>
        <dd>
          <SecuritySummary version={version} />
        </dd>
        <dt>Release notes</dt>
        <dd style={{ whiteSpace: "pre-wrap" }}>{version.release_notes || "None"}</dd>
      </dl>
    </article>
  );
}

const FORK_COPY =
  "Creates a new cloud app in this organization, starting from this version, with the same runtime roles. The new app has no runtime users, plan, or credentials until you add them. This app is unchanged.";

/** Published checkpoints with download/restore and fork. Overwrite is resolved in Studio. */
export default function VersionsTab({ app, isOwner, isAdmin, reloadApp }: AppTabProps): ReactNode {
  const api = useCloudApi();
  const history = useHistory();
  const [pending, setPending] = useState<Pending>(null);
  const [download, setDownload] = useState<AppVersion | null>(null);
  const state = useAsync(async () => {
    const versions = await api.q().versions(app.id);
    const profiles = await api.q().profiles(versions.map((version) => version.developer_id));
    return { versions, profiles };
  }, [api, app.id]);
  const resolve = useAction(async () => {
    if (!pending) return;
    const result = await api.call("versions-resolve", {
      appId: app.id,
      action: "fork",
      fromVersionId: pending.version.id,
      name: `${app.name} (fork ${pending.version.version})`,
    });
    setPending(null);
    if (result.app) history.push(`/cloud/app?id=${result.app.id}&tab=versions`);
    else {
      state.reload();
      reloadApp();
    }
  });

  if (state.loading && !state.data) return <Loading label="Loading versions" />;
  const versions = state.data?.versions ?? [];
  return (
    <>
      <Notice tone="info" title="Publishing happens in Studio">
        Each version is an explicit Publish checkpoint from the desktop app. Autosave never
        publishes. When a publish was based on an older version, Studio reports the conflict and
        asks you to overwrite the current head with your upload or fork it into a new app. You can
        also fork any published version from this page.
      </Notice>
      <ErrorNotice error={state.error} />
      {versions.length === 0 && <Empty>No versions published yet.</Empty>}
      <Section
        title="Versions"
        description={`${versions.length} version${versions.length === 1 ? "" : "s"}, newest first.`}
      >
        {versions.map((version) => (
          <VersionCard
            key={version.id}
            version={version}
            isHead={version.id === app.head_version_id}
            developer={state.data?.profiles[version.developer_id]}
            canManage={isAdmin}
            canDownload={isOwner}
            onAction={setPending}
            onDownload={setDownload}
          />
        ))}
      </Section>
      {pending && (
        <ConfirmDialog
          open
          title="Fork into a new app?"
          confirmLabel="Fork"
          pending={resolve.pending}
          error={resolve.error}
          onConfirm={() => resolve.run()}
          onCancel={() => setPending(null)}
        >
          <p>
            <strong>Version {pending.version.version}</strong>. {FORK_COPY}
          </p>
        </ConfirmDialog>
      )}
      <RestoreDialog
        appId={app.id}
        isPostgres={app.datasource_kind === "postgres"}
        target={download ? { versionId: download.id } : null}
        label={download ? `version ${download.version}` : ""}
        onClose={() => setDownload(null)}
      />
    </>
  );
}
