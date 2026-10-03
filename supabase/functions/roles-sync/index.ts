// Mirrors the desktop's custom Runtime User roles into the cloud app (PRD
// §20.1). Upserts by desktop role id; roles missing from the list are
// deleted unless a member or a pending invitation still uses them (those are
// returned in `kept`). Developer/Owner only. Audits role.sync.
//
// POST {appId, roles:[{id, name, permissions}]} → {roles, kept}
import { audit } from "../_shared/audit.ts";
import { canonicalJson } from "../_shared/crypto.ts";
import { serviceClient } from "../_shared/db.ts";
import { loadApp, requireAppOwner } from "../_shared/distribution.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { arr, obj, record, str, uuid } from "../_shared/validate.ts";

interface RoleInput {
  id: string;
  name: string;
  permissions: Record<string, unknown>;
}

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const roles: RoleInput[] = arr(body, "roles", { max: 200 }).map((item, index) => {
      const role = obj(item, `roles[${index}]`);
      const name = str(role, "name", { max: 200 }).trim();
      if (!name) throw new HttpError("VALIDATION", `roles[${index}].name: is required`);
      const permissions = record(role, "permissions", { optional: true }) ?? {};
      if (JSON.stringify(permissions).length > 200_000)
        throw new HttpError("VALIDATION", `roles[${index}].permissions: is too large`);
      return { id: uuid(role, "id"), name, permissions };
    });
    if (new Set(roles.map((role) => role.id)).size !== roles.length)
      throw new HttpError("VALIDATION", "roles: ids must be unique", { field: "roles" });

    await enforceRateLimit(`roles-sync:${user.id}`, 60, 3600);
    const app = await loadApp(appId);
    requireAppOwner(app, user.id);

    const db = serviceClient();
    const { data: before, error: loadError } = await db
      .from("app_roles")
      .select("id, name, permissions")
      .eq("app_id", appId);
    if (loadError) throw new Error(`load roles: ${loadError.message}`);
    const existing = new Map((before ?? []).map((role) => [role.id as string, role]));

    if (roles.length > 0) {
      const { error } = await db.from("app_roles").upsert(
        roles.map((role) => ({ app_id: appId, ...role })),
        { onConflict: "app_id,id" },
      );
      if (error) throw new Error(`upsert roles: ${error.message}`);
    }

    const wanted = new Set(roles.map((role) => role.id));
    const absent = [...existing.keys()].filter((id) => !wanted.has(id));
    const kept: string[] = [];
    const deleted: string[] = [];
    if (absent.length > 0) {
      const [{ data: members }, { data: invites }] = await Promise.all([
        db.from("app_members").select("role_id").eq("app_id", appId).in("role_id", absent),
        db
          .from("invitations")
          .select("role_id")
          .eq("app_id", appId)
          .in("role_id", absent)
          .is("accepted_at", null)
          .is("revoked_at", null),
      ]);
      const used = new Set(
        [...(members ?? []), ...(invites ?? [])].map((row) => row.role_id as string),
      );
      for (const id of absent) (used.has(id) ? kept : deleted).push(id);
      if (deleted.length > 0) {
        const { error } = await db.from("app_roles").delete().eq("app_id", appId).in("id", deleted);
        if (error) throw new Error(`delete roles: ${error.message}`);
      }
    }

    const created = roles.filter((role) => !existing.has(role.id)).map((role) => role.id);
    const updated = roles
      .filter((role) => {
        const old = existing.get(role.id);
        return (
          old !== undefined &&
          (old.name !== role.name ||
            canonicalJson(old.permissions) !== canonicalJson(role.permissions))
        );
      })
      .map((role) => role.id);
    if (created.length + updated.length + deleted.length > 0) {
      await audit({
        action: "role.sync",
        actorId: user.id,
        orgId: app.org_id,
        appId,
        target: `app:${appId}`,
        details: { created, updated, deleted, kept },
        req,
      });
    }

    const { data: after, error } = await db
      .from("app_roles")
      .select("*")
      .eq("app_id", appId)
      .order("name");
    if (error) throw new Error(`load roles: ${error.message}`);
    return { roles: after ?? [], kept };
  }),
);
