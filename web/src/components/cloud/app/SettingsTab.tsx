import React, { useId, useState, type FormEvent, type ReactNode } from "react";
import { useHistory } from "@docusaurus/router";
import { CloudError, useCloudApi } from "@site/src/lib/cloud";
import { ConfirmDialog, ErrorNotice, Notice, Section } from "../ui";
import { useAction, useAsync } from "../useAsync";
import type { AppTabProps } from "./types";

/** Statuses after which a subscription no longer bills (_shared/billing.ts ENDED_STATUSES). */
const ENDED = ["canceled", "incomplete_expired"];

/** Rename the app, and delete it with a typed confirmation (owner only). */
export default function SettingsTab({ app, isOwner, reloadApp }: AppTabProps): ReactNode {
  const api = useCloudApi();
  const history = useHistory();
  const nameId = useId();
  const [name, setName] = useState(app.name);
  const [saved, setSaved] = useState(false);
  const cancelId = useId();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cancelSubscription, setCancelSubscription] = useState(false);
  const billing = useAsync(
    async () => (isOwner ? ((await api.q().subscriptions([app.id]))[app.id] ?? null) : null),
    [api, app.id, isOwner],
  );
  const subscription = billing.data ?? null;
  const billed = !!subscription && !ENDED.includes(subscription.status);
  const rename = useAction(async () => {
    await api.q().updateApp(app.id, { name: name.trim() });
    setSaved(true);
    reloadApp();
  });
  const remove = useAction(async () => {
    try {
      await api.call("apps-delete", {
        appId: app.id,
        confirm: app.name,
        cancelSubscription: billed && cancelSubscription,
      });
    } catch (error) {
      // Mirrors account deletion: the server refuses while the plan still bills.
      if (error instanceof CloudError && error.details.reason === "active_subscription")
        throw new CloudError(
          "FORBIDDEN",
          "This app still has an active subscription. Select “Cancel the subscription now” to delete it.",
          error.status,
          error.details,
        );
      throw error;
    }
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
            credential keys. Copies already installed on devices keep their local data. An active
            subscription must be cancelled with the app; it ends at once, without a refund for the
            rest of the period.
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
        onCancel={() => {
          remove.clearError();
          setConfirmDelete(false);
        }}
      >
        <p>
          This deletes the cloud app and ends access for every runtime user. The audit history is
          kept.
        </p>
        {billed && (
          <div className="cloud-check">
            <input
              id={cancelId}
              type="checkbox"
              checked={cancelSubscription}
              onChange={(event) => setCancelSubscription(event.target.checked)}
            />
            <label htmlFor={cancelId}>
              Cancel the subscription now ({subscription.plan_id} plan, {subscription.status}).
              Deleting is refused while it still bills.
            </label>
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}
