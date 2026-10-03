import React, { useId, useState, type ReactNode } from "react";
import { formatDate, shortId, useCloudApi } from "@site/src/lib/cloud";
import { entitlementStatus } from "@site/src/lib/cloud/status";
import { ConfirmDialog, Section } from "../ui";
import { useAction, useAsync } from "../useAsync";
import type { AppTabProps } from "./types";

function TransferOwner({ app, user, reloadApp }: AppTabProps): ReactNode {
  const api = useCloudApi();
  const selectId = useId();
  const [target, setTarget] = useState("");
  const [open, setOpen] = useState(false);
  const candidates = useAsync(async () => {
    const q = api.q();
    const members = await q.orgMembers(app.org_id);
    const profiles = await q.profiles(members.map((member) => member.user_id));
    return members
      .filter((member) => member.user_id !== user.id)
      .map((member) => ({
        id: member.user_id,
        label: profiles[member.user_id]?.email || member.user_id,
      }));
  }, [api, app.org_id, user.id]);
  const transfer = useAction(async () => {
    await api.call("apps-transfer", { appId: app.id, newOwnerId: target, confirm: app.name });
    setOpen(false);
    reloadApp();
  });
  const options = candidates.data ?? [];
  const chosen = options.find((option) => option.id === target);
  return (
    <Section
      title="Transfer ownership"
      description="An app has exactly one Developer/Owner. The new owner must be a member of this organization. You lose owner rights, including credential management, when the transfer completes."
    >
      <div className="cloud-inline-form">
        <div className="cloud-field">
          <label htmlFor={selectId}>New owner</label>
          <select id={selectId} value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">Choose a member</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="button button--outline button--danger"
          disabled={!target}
          onClick={() => setOpen(true)}
        >
          Transfer ownership
        </button>
      </div>
      <ConfirmDialog
        open={open}
        title="Transfer ownership?"
        confirmLabel="Transfer"
        confirmText={app.name}
        danger
        pending={transfer.pending}
        error={transfer.error}
        onConfirm={() => transfer.run()}
        onCancel={() => setOpen(false)}
      >
        <p>
          {chosen?.label} becomes the only Developer/Owner of {app.name}. They publish versions and
          manage credentials from then on. The transfer is recorded in the audit history.
        </p>
      </ConfirmDialog>
    </Section>
  );
}

export default function OverviewTab(props: AppTabProps): ReactNode {
  const { app, owner, isOwner, entitlement } = props;
  const status = entitlementStatus(entitlement);
  return (
    <>
      <dl className="cloud-dl" aria-label="App details">
        <dt>Developer/Owner</dt>
        <dd data-testid="app-owner">
          {owner?.email || shortId(app.owner_id)}
          {isOwner && <span className="cloud-muted"> (you)</span>}
        </dd>
        <dt>Status</dt>
        <dd>
          {status.label}. {status.help}
        </dd>
        <dt>Runtime users</dt>
        <dd>
          {entitlement ? `${entitlement.used} of ${entitlement.allowance} allowed` : "Unknown"}
        </dd>
        <dt>Datasource</dt>
        <dd>{app.datasource_kind === "postgres" ? "External PostgreSQL" : "Embedded SQLite"}</dd>
        <dt>Backups</dt>
        <dd>{app.backups_enabled ? "Installation backups on" : "Installation backups off"}</dd>
        <dt>Created</dt>
        <dd>{formatDate(app.created_at)}</dd>
        <dt>App id</dt>
        <dd className="cloud-code">{app.id}</dd>
      </dl>
      {isOwner && <TransferOwner {...props} />}
    </>
  );
}
