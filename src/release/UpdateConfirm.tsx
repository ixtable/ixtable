import { useId } from "react";
import type { PendingMigration } from "./types";

/** Release notes and the migrations an update will run on this installation (PRD §22.3 step 7). */
export function UpdateDetails({
  releaseNotes,
  migrations,
}: {
  releaseNotes: string;
  migrations: PendingMigration[];
}) {
  return (
    <>
      <h3>Release notes</h3>
      <p className="release-notes">{releaseNotes.trim() || "No release notes."}</p>
      <h3>Migrations</h3>
      {migrations.length === 0 ? (
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

/** Confirm step before a manual update is applied. */
export function UpdateConfirm({
  name,
  version,
  installedVersion,
  releaseNotes,
  migrations,
  busy,
  onApply,
  onCancel,
}: {
  name: string;
  version: string;
  installedVersion?: string | null;
  releaseNotes: string;
  migrations: PendingMigration[];
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  return (
    <div className="bundle-password" role="dialog" aria-labelledby={titleId}>
      <h2 id={titleId}>
        Update {name} to {version}?
      </h2>
      {installedVersion && <p>Installed version: {installedVersion}. Your records are kept.</p>}
      <UpdateDetails releaseNotes={releaseNotes} migrations={migrations} />
      <div className="settings-actions">
        <button type="button" className="save" disabled={busy} onClick={onApply}>
          Apply update
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
