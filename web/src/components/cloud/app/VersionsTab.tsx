import React, { useState, type ReactNode } from "react";
import { useHistory } from "@docusaurus/router";
import {
  CloudError,
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

type Pending =
  | { kind: "fork"; version: AppVersion }
  // `installations` is set once the server asked for confirmation (422 requiresConfirm).
  | { kind: "withdraw"; version: AppVersion; installations: number | null }
  | null;

function migrationLabel(migration: MigrationRef | string): string {
  return typeof migration === "string" ? migration : (migration.name ?? migration.id);
}

/** The camelCase summary publish-checkpoint stores (SecuritySummary in lib/cloud/types). */
function SecuritySummary({ version }: { version: AppVersion }): ReactNode {
  const security = version.security;
  if (!security) return <>Not recorded</>;
  const mode = security.credentialMode;
  return (
    <div className="cloud-actions">
      <Badge>{security.store === "postgres" ? "PostgreSQL" : "SQLite"}</Badge>
      {mode && (
        <Badge tone={mode === "shared" ? "warning" : "neutral"}>
          Credentials: {mode === "shared" ? "one shared login" : "one login per user"}
        </Badge>
      )}
      {security.tls ? (
        <Badge tone="success">TLS required</Badge>
      ) : (
        <Badge tone="danger">
          Non-TLS override confirmed
          {security.insecureTransportConfirmedAt
            ? ` ${formatDate(security.insecureTransportConfirmedAt)}`
            : ""}
        </Badge>
      )}
      {mode === "shared" && security.sharedCredentialAcknowledged && (
        <Badge tone="warning">Shared credential warning acknowledged</Badge>
      )}
      {security.concurrencyPoliciesResolved && <Badge>Concurrency policies resolved</Badge>}
    </div>
  );
}

function VersionCard({
  version,
  isHead,
  developer,
  canManage,
  onAction,
  onDownload,
}: {
  version: AppVersion;
  isHead: boolean;
  developer: Profile | undefined;
  canManage: boolean;
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
            <button
              type="button"
              className="button button--sm button--secondary"
              onClick={() => onDownload(version)}
            >
              Download or restore {version.version}
            </button>
            {version.status === "published" && (
              <>
                <button
                  type="button"
                  className="button button--sm button--secondary"
                  onClick={() => onAction({ kind: "fork", version })}
                >
                  Fork {version.version} into a new app
                </button>
                <button
                  type="button"
                  className="button button--sm button--outline button--danger"
                  onClick={() => onAction({ kind: "withdraw", version, installations: null })}
                >
                  Withdraw {version.version}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <dl className="cloud-dl">
        <dt>Developer</dt>
        <dd>{developer?.email || shortId(version.developer_id)}</dd>
        <dt>Published</dt>
        <dd>{formatDate(version.published_at ?? version.created_at)}</dd>
        {version.withdrawn_at && (
          <>
            <dt>Withdrawn</dt>
            <dd>{formatDate(version.withdrawn_at)}</dd>
          </>
        )}
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

const WITHDRAW_COPY =
  "Runtime users stop receiving this version. If it is the current head, the head moves back to the newest remaining published version and installations switch to it on their next sync. The version row and its archive are kept for the audit history.";

const FORK_COPY =
  "Creates a new cloud app in this organization, starting from this version, with the same runtime roles. The new app has no runtime users, plan, or credentials until you add them. This app is unchanged.";

/**
 * Published checkpoints with download/restore, fork and withdraw (Developer/Owner only:
 * versions-resolve and restore-url refuse everyone else). Overwrite is resolved in Studio.
 */
export default function VersionsTab({ app, isOwner, reloadApp }: AppTabProps): ReactNode {
  const api = useCloudApi();
  const history = useHistory();
  const [pending, setPending] = useState<Pending>(null);
  const [done, setDone] = useState<string | null>(null);
  const [download, setDownload] = useState<AppVersion | null>(null);
  const state = useAsync(async () => {
    const versions = await api.q().versions(app.id);
    const profiles = await api.q().profiles(versions.map((version) => version.developer_id));
    return { versions, profiles };
  }, [api, app.id]);
  const resolve = useAction(async () => {
    if (!pending) return;
    if (pending.kind === "withdraw") {
      try {
        const result = await api.call("versions-resolve", {
          appId: app.id,
          action: "withdraw",
          versionId: pending.version.id,
          // Sent only after the server asked for it, with the count shown in the dialog.
          ...(pending.installations !== null ? { confirm: true } : {}),
        });
        const head = state.data?.versions.find((v) => v.id === result.headVersionId);
        setDone(
          `Version ${pending.version.version} withdrawn. ${
            head ? `Runtime users now get version ${head.version}.` : "No version is published now."
          }`,
        );
      } catch (error) {
        const details = error instanceof CloudError ? error.details : {};
        if (details.requiresConfirm === true) {
          setPending({ ...pending, installations: Number(details.installations ?? 0) });
          return;
        }
        throw error;
      }
      setPending(null);
      state.reload();
      reloadApp();
      return;
    }
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
      <Notice tone="info" title="Publishing and overwrite happen in Studio">
        Each version is an explicit Publish checkpoint from the desktop app. Autosave never
        publishes. When someone published a newer version since your document was based on the head,
        Studio reports the conflict and offers two choices: <strong>Overwrite</strong> publishes
        your upload as the new head anyway (the other version stays in this list), or{" "}
        <strong>Fork</strong> starts a new app from it. Overwrite needs the archive you are
        publishing, so it is only available in Studio. Here you can fork or withdraw a published
        version.
      </Notice>
      <ErrorNotice error={state.error} />
      {done && (
        <Notice tone="success" testId="version-withdrawn">
          {done}
        </Notice>
      )}
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
            canManage={isOwner}
            onAction={setPending}
            onDownload={setDownload}
          />
        ))}
      </Section>
      {pending?.kind === "fork" && (
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
      {pending?.kind === "withdraw" && (
        <ConfirmDialog
          open
          title={`Withdraw version ${pending.version.version}?`}
          confirmLabel={pending.installations === null ? "Withdraw" : "Withdraw anyway"}
          danger
          pending={resolve.pending}
          error={resolve.error}
          onConfirm={() => resolve.run()}
          onCancel={() => {
            resolve.clearError();
            setPending(null);
          }}
        >
          <p>{WITHDRAW_COPY}</p>
          {pending.installations !== null && (
            <Notice
              tone="warning"
              title="This is the only published version"
              testId="withdraw-confirm"
            >
              {pending.installations} installation{pending.installations === 1 ? " runs" : "s run"}{" "}
              this version. After withdrawing there is no version to sync to: runtime users keep the
              copy they have, cannot install the app on new devices, and get nothing new until you
              publish again.
            </Notice>
          )}
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
