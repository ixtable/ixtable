import React, { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { formatBytes, formatDate, shortId, useCloudApi, type Backup } from "@site/src/lib/cloud";
import { Empty, ErrorNotice, Loading, Notice, Section, TableWrap } from "../ui";
import { useAction, useAsync } from "../useAsync";
import RestoreDialog from "./RestoreDialog";
import type { AppTabProps } from "./types";

function BackupSettings({ app, reloadApp }: AppTabProps): ReactNode {
  const api = useCloudApi();
  const enabledId = useId();
  const versionsId = useId();
  const daysId = useId();
  const [enabled, setEnabled] = useState(app.backups_enabled);
  const [versions, setVersions] = useState(String(app.retention_versions));
  const [days, setDays] = useState(app.retention_days ? String(app.retention_days) : "");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setEnabled(app.backups_enabled);
    setVersions(String(app.retention_versions));
    setDays(app.retention_days ? String(app.retention_days) : "");
  }, [app]);
  const save = useAction(async () => {
    await api.q().updateApp(app.id, {
      backups_enabled: enabled,
      retention_versions: Number(versions),
      retention_days: days ? Number(days) : null,
    });
    setSaved(true);
    reloadApp();
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    save.run();
  };
  return (
    <form onSubmit={submit} aria-label="Backup settings">
      <div className="cloud-check">
        <input
          id={enabledId}
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <label htmlFor={enabledId}>
          Back up runtime installations. Each installation uploads its own local SQLite state to a
          separate stream. Streams are never merged.
        </label>
      </div>
      <div className="cloud-inline-form">
        <div className="cloud-field">
          <label htmlFor={versionsId}>Keep this many archives per stream</label>
          <input
            id={versionsId}
            type="number"
            min={1}
            max={1000}
            required
            value={versions}
            onChange={(event) => setVersions(event.target.value)}
          />
        </div>
        <div className="cloud-field">
          <label htmlFor={daysId}>Delete archives older than (days, blank keeps all)</label>
          <input
            id={daysId}
            type="number"
            min={1}
            max={3650}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        </div>
        <button type="submit" className="button button--primary" disabled={save.pending}>
          Save backup settings
        </button>
      </div>
      <p className="cloud-muted">
        Retention applies to the developer version stream and to every installation stream.
      </p>
      <ErrorNotice error={save.error} />
      {saved && (
        <Notice tone="success" testId="backup-settings-saved">
          Backup settings saved.
        </Notice>
      )}
    </form>
  );
}

/** Developer stream summary, per-installation backup streams, and retention settings. */
export default function BackupsTab(props: AppTabProps): ReactNode {
  const { app, isOwner } = props;
  const api = useCloudApi();
  const [restore, setRestore] = useState<Backup | null>(null);
  const state = useAsync(async () => {
    const q = api.q();
    const [backups, installations, versions] = await Promise.all([
      q.backups(app.id),
      q.installations(app.id),
      q.versions(app.id),
    ]);
    const profiles = await q.profiles(backups.map((backup) => backup.user_id));
    return { backups, installations, versions, profiles };
  }, [api, app.id]);

  if (state.loading && !state.data) return <Loading label="Loading backups" />;
  const data = state.data;
  const streams = new Map<string, Backup[]>();
  for (const backup of data?.backups ?? []) {
    streams.set(backup.installation_id, [...(streams.get(backup.installation_id) ?? []), backup]);
  }
  return (
    <>
      <ErrorNotice error={state.error} />
      <Section
        title="Developer stream"
        description="Published versions of the app definition and bootstrap data."
      >
        <p>
          {data?.versions.length ?? 0} archived versions. See the Versions tab to download or
          restore one.
        </p>
      </Section>
      <Section
        title="Installation streams"
        description="One stream per runtime installation, keyed by user and device."
      >
        {!app.backups_enabled && (
          <Notice tone="info">Installation backups are off. Turn them on below.</Notice>
        )}
        {streams.size === 0 && <Empty>No installation backups yet.</Empty>}
        {[...streams.entries()].map(([installationId, backups]) => {
          const installation = data?.installations.find((row) => row.id === installationId);
          const email = data?.profiles[backups[0].user_id]?.email || shortId(backups[0].user_id);
          const name = `${email} on ${installation?.device_name || shortId(installationId)}`;
          return (
            <div key={installationId} className="cloud-section">
              <h3>{name}</h3>
              <TableWrap label={`Backups for ${name}`}>
                <thead>
                  <tr>
                    <th scope="col">Uploaded</th>
                    <th scope="col">Size</th>
                    <th scope="col">Checksum</th>
                    {isOwner && <th scope="col">Restore</th>}
                  </tr>
                </thead>
                <tbody>
                  {backups.map((backup) => (
                    <tr key={backup.id}>
                      <td>{formatDate(backup.created_at)}</td>
                      <td>{formatBytes(backup.archive_size)}</td>
                      <td className="cloud-code">{backup.archive_sha256.slice(0, 16)}</td>
                      {isOwner && (
                        <td>
                          <button
                            type="button"
                            className="button button--sm button--secondary"
                            onClick={() => setRestore(backup)}
                          >
                            Restore backup from {formatDate(backup.created_at)}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </div>
          );
        })}
      </Section>
      <Section title="Backup settings">
        <BackupSettings {...props} />
      </Section>
      <RestoreDialog
        appId={app.id}
        isPostgres={app.datasource_kind === "postgres"}
        target={restore ? { backupId: restore.id } : null}
        label="installation backup"
        onClose={() => setRestore(null)}
      />
    </>
  );
}
