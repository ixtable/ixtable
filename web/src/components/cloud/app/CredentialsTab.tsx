import React, { useState, type ReactNode } from "react";
import { formatDate, shortId, useCloudApi, type CredentialEnvelopeMeta } from "@site/src/lib/cloud";
import { Badge, ConfirmDialog, Empty, ErrorNotice, Loading, Notice, TableWrap } from "../ui";
import { useAction, useAsync } from "../useAsync";
import type { AppTabProps } from "./types";

/**
 * Credential envelope metadata only. The website never reads ciphertext or keys; RLS grants
 * only the metadata columns, and only to the app owner.
 */
export default function CredentialsTab({ app }: AppTabProps): ReactNode {
  const api = useCloudApi();
  const state = useAsync(async () => {
    const envelopes = await api.q().credentialEnvelopes(app.id);
    const profiles = await api.q().profiles(envelopes.map((row) => row.user_id ?? ""));
    return { envelopes, profiles };
  }, [api, app.id]);
  const [target, setTarget] = useState<CredentialEnvelopeMeta | null>(null);
  const revoke = useAction(async () => {
    if (!target) return;
    await api.call("credential-delete", {
      appId: app.id,
      datasourceId: target.datasource_id,
      scope: target.scope,
      ...(target.user_id ? { userId: target.user_id } : {}),
    });
    setTarget(null);
    state.reload();
  });

  if (state.loading && !state.data) return <Loading label="Loading credentials" />;
  const data = state.data;
  const hasShared = data?.envelopes.some((row) => row.scope === "shared" && !row.revoked_at);
  return (
    <>
      <Notice tone="info" title="Credentials are uploaded from Studio">
        Studio encrypts each datasource secret on your computer before upload. ixtable Cloud stores
        the encrypted envelope and releases its key only to active runtime users, for at most 24
        hours at a time. This page shows metadata. Secrets are never displayed.
      </Notice>
      {hasShared && (
        <Notice tone="warning" title="Shared credentials" testId="shared-credential-warning">
          Every runtime user of this app receives the same database credential. Any of them can
          extract it and use it outside ixtable, and revoking a user cannot take it back. Use a
          separate least-privileged credential per user, and rotate the shared one after you revoke
          someone.
        </Notice>
      )}
      <ErrorNotice error={state.error} />
      {data?.envelopes.length === 0 && <Empty>No credentials uploaded for this app.</Empty>}
      {data && data.envelopes.length > 0 && (
        <TableWrap label="Credential envelopes">
          <thead>
            <tr>
              <th scope="col">Datasource</th>
              <th scope="col">Scope</th>
              <th scope="col">Key version</th>
              <th scope="col">Updated</th>
              <th scope="col">Last key grant</th>
              <th scope="col">Status</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {data.envelopes.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="cloud-code">
                  {row.datasource_id}
                </th>
                <td>
                  {row.scope === "shared" ? (
                    <Badge tone="warning">Shared</Badge>
                  ) : (
                    <>
                      <Badge>Per user</Badge>{" "}
                      {data.profiles[row.user_id ?? ""]?.email || shortId(row.user_id)}
                    </>
                  )}
                </td>
                <td>v{row.kek_version}</td>
                <td>{formatDate(row.updated_at)}</td>
                <td>{formatDate(row.last_grant_at)}</td>
                <td>
                  {row.revoked_at ? (
                    <Badge tone="danger">Revoked</Badge>
                  ) : (
                    <Badge tone="success">Active</Badge>
                  )}
                </td>
                <td>
                  {!row.revoked_at && (
                    <button
                      type="button"
                      className="button button--sm button--outline button--danger"
                      onClick={() => setTarget(row)}
                    >
                      Revoke {row.datasource_id}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <ConfirmDialog
        open={target !== null}
        title="Revoke this credential?"
        confirmLabel="Revoke credential"
        danger
        pending={revoke.pending}
        error={revoke.error}
        onConfirm={() => revoke.run()}
        onCancel={() => setTarget(null)}
      >
        <p>
          ixtable Cloud erases the encrypted credential for {target?.datasource_id}, so no runtime
          user gets a new key grant for it. Runtimes that already decrypted it keep a working copy.
          Rotate the password in your database to cut off that access, then upload the new
          credential from Studio.
        </p>
      </ConfirmDialog>
    </>
  );
}
