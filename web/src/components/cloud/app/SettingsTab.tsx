import React, { useId, useState, type FormEvent, type ReactNode } from "react";
import { useHistory } from "@docusaurus/router";
import { useCloudApi } from "@site/src/lib/cloud";
import { ConfirmDialog, ErrorNotice, Notice, Section } from "../ui";
import { useAction } from "../useAsync";
import type { AppTabProps } from "./types";

/** Rename the app, and delete it with a typed confirmation (owner only). */
export default function SettingsTab({ app, isOwner, reloadApp }: AppTabProps): ReactNode {
  const api = useCloudApi();
  const history = useHistory();
  const nameId = useId();
  const [name, setName] = useState(app.name);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rename = useAction(async () => {
    await api.q().updateApp(app.id, { name: name.trim() });
    setSaved(true);
    reloadApp();
  });
  const remove = useAction(async () => {
    await api.call("apps-delete", { appId: app.id, confirm: app.name });
    history.replace(`/cloud?org=${app.org_id}`);
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    rename.run();
  };
  return (
    <>
      <Section
        title="Rename"
        description="The name runtime users see in the desktop app after their next sync."
      >
        <form className="cloud-inline-form" onSubmit={submit} aria-label="Rename app">
          <div className="cloud-field">
            <label htmlFor={nameId}>App name</label>
            <input
              id={nameId}
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <button
            type="submit"
            className="button button--primary"
            disabled={rename.pending || !name.trim() || name.trim() === app.name}
          >
            Save name
          </button>
        </form>
        <ErrorNotice error={rename.error} />
        {saved && (
          <Notice tone="success" testId="app-renamed">
            App renamed.
          </Notice>
        )}
      </Section>
      {isOwner && (
        <Section title="Delete app" description="Only the Developer/Owner can delete an app.">
          <Notice tone="danger" title="Deleting cannot be undone">
            Runtime users lose access at once. They can no longer sync, download bundles, or get
            credential keys. Copies already installed on devices keep their local data. Cancel the
            subscription first if you do not want another charge.
          </Notice>
          <button
            type="button"
            className="button button--danger"
            onClick={() => setConfirmDelete(true)}
          >
            Delete {app.name}
          </button>
        </Section>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${app.name}?`}
        confirmLabel="Delete app"
        confirmText={app.name}
        danger
        pending={remove.pending}
        error={remove.error}
        onConfirm={() => remove.run()}
        onCancel={() => setConfirmDelete(false)}
      >
        <p>
          This deletes the cloud app and ends access for every runtime user. The audit history is
          kept.
        </p>
      </ConfirmDialog>
    </>
  );
}
