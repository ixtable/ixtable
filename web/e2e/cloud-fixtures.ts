import { createHash, randomUUID } from "node:crypto";
import type { CloudFixture } from "./service-qa/fixture";
import { addMember, createRole, grantSubscription } from "./service-qa/seed";

/**
 * A published SQLite app with one runtime user, one role, one version that records a
 * confirmed non-TLS override, a Team subscription, and an audit event.
 */
export async function seedPublishedApp(
  cloud: CloudFixture,
  opts: { datasourceKind?: "sqlite" | "postgres" } = {},
) {
  const owner = await cloud.user();
  const runtimeUser = await cloud.user();
  const org = await cloud.org(owner);
  const app = await cloud.app(org, owner, { datasourceKind: opts.datasourceKind ?? "sqlite" });
  const role = await createRole(app.id, {
    name: "Clerk",
    permissions: {
      navigation: ["nav-orders"],
      objects: [
        { kind: "form", id: "orders-form", read: true, create: true, update: false, delete: false },
      ],
      actions: ["send-invoice"],
    },
  });
  await addMember(app.id, runtimeUser.user.id, role.id);
  await grantSubscription(app.id, "team");
  const versionId = randomUUID();
  const sha = createHash("sha256").update(versionId).digest("hex");
  const { error } = await cloud.admin.from("app_versions").insert({
    id: versionId,
    app_id: app.id,
    version: "1.2.0",
    developer_id: owner.user.id,
    archive_sha256: sha,
    archive_size: 3 * 1024 * 1024,
    storage_path: `apps/${app.id}/versions/${versionId}.ixt`,
    migrations: [{ id: "m-001", name: "add-orders" }],
    min_runtime_version: "0.4.0",
    security: {
      credential_mode: "shared",
      tls: false,
      insecure_override_confirmed: true,
      shared_credential_warning_acknowledged: true,
    },
    release_notes: "Adds the orders form.",
    status: "published",
  });
  if (error) throw new Error(`seed version: ${error.message}`);
  await cloud.admin.from("cloud_apps").update({ head_version_id: versionId }).eq("id", app.id);
  await cloud.admin.rpc("audit", {
    p_action: "version.publish",
    p_actor_id: owner.user.id,
    p_app_id: app.id,
    p_target: versionId,
    p_details: { version: "1.2.0" },
  });
  return { owner, runtimeUser, org, app, role, versionId, sha };
}
