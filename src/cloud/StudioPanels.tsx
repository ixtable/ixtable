import { type FormEvent, useEffect, useId, useState } from "react";
import { useDocumentConfig } from "../lib/config-store";
import { useShell } from "../shell/context";
import { uploadCredential } from "./api";
import {
  createOrganization,
  getApp,
  invokeFunction,
  listOrganizations,
  requireSession,
} from "./client";
import { CloudErrorNotice } from "./CloudErrorNotice";
import { useCloudAction } from "./useCloudAction";
import { CloudError } from "./errors";
import type { Organization } from "./types";

export function ActionStatus({ error, notice }: { error: CloudError | null; notice: string }) {
  return (
    <>
      {notice && (
        <p className="cloud-notice" role="status">
          {notice}
        </p>
      )}
      {error && <CloudErrorNotice error={error} />}
    </>
  );
}

const rolePayload = (roles: { id: string; name: string; permissions: unknown }[]) =>
  roles.map((role) => ({ id: role.id, name: role.name, permissions: role.permissions }));

/** Creates (or links) the cloud application for this document. */
export function LinkPanel() {
  const { config, update, settled } = useDocumentConfig();
  const { doc } = useShell();
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [orgId, setOrgId] = useState("");
  const [orgName, setOrgName] = useState("");
  const [name, setName] = useState(config.name);
  const [existing, setExisting] = useState("");
  const { busy, error, notice, run } = useCloudAction();
  const titleId = useId();

  useEffect(() => {
    listOrganizations()
      .then((all) => {
        const managed = all.filter((org) => org.role === "owner" || org.role === "admin");
        setOrgs(managed);
        setOrgId((current) => current || managed[0]?.id || "");
      })
      .catch(() => setOrgs([]));
  }, []);

  const link = async (appId: string, linkedOrg: string) => {
    await update(
      (draft) => ({ ...draft, cloud: { appId, orgId: linkedOrg } }),
      "Link cloud application",
    );
    await settled();
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      let target = orgId;
      if (!target) {
        if (!orgName.trim()) throw new CloudError("VALIDATION", "Name the new organization.");
        const org = await createOrganization(orgName.trim());
        target = org.id;
      }
      const reply = await invokeFunction("apps-create", {
        orgId: target,
        name: name.trim() || config.name,
        documentId: doc.documentId,
        datasourceKind: config.datasource?.kind === "postgres" ? "postgres" : "sqlite",
      });
      if ((config.roles ?? []).length)
        await invokeFunction("roles-sync", {
          appId: reply.app.id,
          roles: rolePayload(config.roles),
        });
      await link(reply.app.id, target);
      return "Cloud application created and linked to this document.";
    }).catch(() => undefined);
  };
  const linkExisting = () =>
    run(async () => {
      const session = await requireSession();
      const app = await getApp(existing.trim());
      if (!app)
        throw new CloudError("NOT_FOUND", "No cloud application with that id is visible to you.");
      if (app.ownerId !== session.user.id)
        throw new CloudError("FORBIDDEN", "Only the application's owner can publish to it.");
      await link(app.id, app.orgId);
      return `Linked to ${app.name}.`;
    });

  return (
    <section className="cloud-card" aria-labelledby={titleId}>
      <h2 id={titleId}>Create a cloud application</h2>
      <p className="cloud-muted">
        A cloud application has exactly one developer (you) and the runtime users you invite. It is
        private: nobody can find or download it without an invitation.
      </p>
      <form className="cloud-form" onSubmit={create}>
        {orgs && orgs.length > 0 ? (
          <label>
            Organization
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            New organization name
            <input value={orgName} onChange={(e) => setOrgName(e.target.value)} />
          </label>
        )}
        <label>
          Application name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="cloud-actions">
          <button type="submit" className="save" disabled={busy || orgs === null}>
            Create cloud application
          </button>
        </div>
      </form>
      <div className="cloud-form inline">
        <label>
          Existing application id
          <input value={existing} onChange={(e) => setExisting(e.target.value)} />
        </label>
        <button type="button" disabled={busy || !existing.trim()} onClick={linkExisting}>
          Link existing application
        </button>
      </div>
      <ActionStatus error={error} notice={notice} />
    </section>
  );
}

/** Uploads the document's runtime roles (`roles-sync`, upsert by role id). */
export function RolesPanel({ appId }: { appId: string }) {
  const { config } = useDocumentConfig();
  const roles = config.roles ?? [];
  const { busy, error, notice, run } = useCloudAction();
  const titleId = useId();
  return (
    <section className="cloud-card" aria-labelledby={titleId}>
      <h2 id={titleId}>Runtime roles</h2>
      <p className="cloud-muted">
        {roles.length} role(s) defined in the Roles tab. Invited runtime users get one of them;
        ixtable enforces it in navigation, forms, reports, dashboards, and actions.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          run(async () => {
            await invokeFunction("roles-sync", { appId, roles: rolePayload(roles) });
            return `Synced ${roles.length} role(s) to ixtable Cloud.`;
          })
        }
      >
        Sync roles to cloud
      </button>
      <ActionStatus error={error} notice={notice} />
    </section>
  );
}

/** Encrypted PostgreSQL credential delivery (PRD §21.3) with the shared-credential warning. */
export function CredentialsPanel({ appId }: { appId: string }) {
  const { config } = useDocumentConfig();
  const shared = (config.datasource?.credentialMode ?? "shared") !== "perUser";
  const [scope, setScope] = useState<"shared" | "user">(shared ? "shared" : "user");
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, notice, run } = useCloudAction();
  const titleId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      const session = await requireSession();
      await uploadCredential(
        session.access_token,
        appId,
        scope,
        scope === "user" ? userId.trim() : null,
        password || null,
      );
      setPassword("");
      return scope === "shared"
        ? "Shared credential encrypted and uploaded."
        : "Credential for that user encrypted and uploaded.";
    }).catch(() => undefined);
  };
  return (
    <section className="cloud-card" aria-labelledby={titleId}>
      <h2 id={titleId}>Datasource credentials</h2>
      <p className="cloud-warning" role="note">
        Runtime users connect to PostgreSQL directly. An authorized user can extract the credential
        they receive, and ixtable roles do not limit what that credential can do in the database.
        Use separate, least-privileged credentials per user for strong isolation. Revoking a user
        stops future key grants but cannot erase a credential they already saw.
      </p>
      <form className="cloud-form" onSubmit={submit}>
        <fieldset>
          <legend>Credential scope</legend>
          <label className="checkbox">
            <input
              type="radio"
              name="credential-scope"
              checked={scope === "shared"}
              onChange={() => setScope("shared")}
            />
            One shared credential for every runtime user
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name="credential-scope"
              checked={scope === "user"}
              onChange={() => setScope("user")}
            />
            A separate credential for one user
          </label>
        </fieldset>
        {scope === "user" && (
          <label>
            Runtime user id
            <input value={userId} required onChange={(e) => setUserId(e.target.value)} />
          </label>
        )}
        <label>
          Password {scope === "shared" && <small>(leave blank to use the stored password)</small>}
          <input
            type="password"
            autoComplete="new-password"
            required={scope === "user"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <div className="cloud-actions">
          <button type="submit" disabled={busy}>
            Encrypt and upload credential
          </button>
        </div>
      </form>
      <ActionStatus error={error} notice={notice} />
    </section>
  );
}
