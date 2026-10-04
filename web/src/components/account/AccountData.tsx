import React, { useId, useState, type ReactNode } from "react";
import { useHistory } from "@docusaurus/router";
import type { User } from "@supabase/supabase-js";
import { useAuth } from "@site/src/contexts/AuthContext";
import { useCloudApi } from "@site/src/lib/cloud";
import { ConfirmDialog, ErrorNotice, Notice, Section } from "../cloud/ui";
import { useAction } from "../cloud/useAsync";

export function ExportSection(): ReactNode {
  const api = useCloudApi();
  const [archives, setArchives] = useState<string[] | null>(null);
  const exportData = useAction(async () => {
    const result = await api.call("account-export", {});
    const blob = new Blob([JSON.stringify(result.export, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ixtable-account-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    setArchives(result.archives ?? []);
  });
  return (
    <Section
      title="Export your data"
      description="Downloads a JSON file with your profile, organizations, apps, memberships, and audit events. Archive download links expire after a short time."
    >
      <button
        type="button"
        className="button button--secondary"
        disabled={exportData.pending}
        onClick={() => exportData.run()}
      >
        {exportData.pending ? "Preparing export..." : "Export account data"}
      </button>
      <ErrorNotice error={exportData.error} />
      {archives && (
        <Notice tone="success" testId="account-export-done">
          Export downloaded.
          {archives.length > 0 && (
            <ul>
              {archives.map((url, index) => (
                <li key={url}>
                  <a href={url}>Archive {index + 1}</a>
                </li>
              ))}
            </ul>
          )}
        </Notice>
      )}
    </Section>
  );
}

export function DeleteAccountSection({ user }: { user: User }): ReactNode {
  const api = useCloudApi();
  const { signOut } = useAuth();
  const history = useHistory();
  const cancelId = useId();
  const [open, setOpen] = useState(false);
  const [cancelSubscriptions, setCancelSubscriptions] = useState(false);
  const remove = useAction(async () => {
    await api.call("account-delete", { confirmEmail: user.email ?? "", cancelSubscriptions });
    await signOut();
    history.replace("/");
  });
  return (
    <Section title="Delete account">
      <Notice tone="danger" title="Deleting your account cannot be undone">
        You lose access to every organization and app. Apps you own must be transferred or deleted
        first, unless you also cancel their subscriptions below. The audit history keeps a record of
        past actions without your profile.
      </Notice>
      <div className="cloud-check">
        <input
          id={cancelId}
          type="checkbox"
          checked={cancelSubscriptions}
          onChange={(event) => setCancelSubscriptions(event.target.checked)}
        />
        <label htmlFor={cancelId}>
          Cancel the subscriptions of apps I own, effective immediately.
        </label>
      </div>
      <button type="button" className="button button--danger" onClick={() => setOpen(true)}>
        Delete my account
      </button>
      <ConfirmDialog
        open={open}
        title="Delete your account?"
        confirmLabel="Delete account"
        confirmText={user.email ?? ""}
        danger
        pending={remove.pending}
        error={remove.error}
        onConfirm={() => remove.run()}
        onCancel={() => {
          remove.clearError();
          setOpen(false);
        }}
      >
        <p>
          {cancelSubscriptions
            ? "Subscriptions of apps you own are cancelled now."
            : "Deletion is refused while you own an app with an active subscription."}
        </p>
      </ConfirmDialog>
    </Section>
  );
}
