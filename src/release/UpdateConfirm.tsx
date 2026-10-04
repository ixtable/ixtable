import { useId } from "react";
import type { PendingMigration } from "./types";

/** Release notes and the migrations an update will run on this installation (PRD §22.3 step 7). */
export function UpdateDetails({
  releaseNotes,
  migrations,
  migrationsUnavailable,
}: {
  releaseNotes: string;
  migrations: PendingMigration[] | null;
  migrationsUnavailable?: string | null;
}) {
  return (
    <>
      <h3>Release notes</h3>
      <div className="release-notes">{releaseNotes.trim() || "No release notes."}</div>
      <h3>Migrations</h3>
      {migrations === null ? (
        <p role="note">
          The migration preview is unavailable
          {migrationsUnavailable ? ` (${migrationsUnavailable})` : ""}. Pending migrations still run
          when you apply.
        </p>
      ) : migrations.length === 0 ? (
        <p>No migrations will run on your records.</p>
      ) : (
        <ul aria-label="Migrations">
          {migrations.map((migration) => (
            <li key={migration.id}>
              {migration.name || migration.id}
              <details>
                <summary>SQL</summary>
                <pre>{migration.sql}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Confirm step before a manual update or downgrade is applied. */
export function UpdateConfirm({
  name,
  version,
  installedVersion,
  releaseNotes,
  migrations,
  migrationsUnavailable,
  downgrade = false,
  busy,
  onApply,
  onCancel,
}: {
  name: string;
  version: string;
  installedVersion?: string | null;
  releaseNotes: string;
  migrations: PendingMigration[] | null;
  migrationsUnavailable?: string | null;
  downgrade?: boolean;
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  return (
    <div className="bundle-password" role="dialog" aria-labelledby={titleId}>
      <h2 id={titleId}>
        {downgrade
          ? `Install older version ${version} of ${name}?`
          : `Update ${name} to ${version}?`}
      </h2>
      {installedVersion && <p>Installed version: {installedVersion}. Your records are kept.</p>}
      <UpdateDetails
        releaseNotes={releaseNotes}
        migrations={migrations}
        migrationsUnavailable={migrationsUnavailable}
      />
      <div className="settings-actions">
        <button type="button" className="save" disabled={busy} onClick={onApply}>
          {downgrade ? `Install older version ${version} anyway` : "Apply update"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
