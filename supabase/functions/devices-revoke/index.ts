// Revokes a Runtime installation (device). App admins (owner, org
// owner/admin) revoke any installation of the app; a Runtime User may revoke
// their own. A revoked installation gets no further key grants or bundle
// manifests, and its unexpired key grants are marked revoked. Credentials
// already decrypted on the device stay usable until the developer rotates
// them (PRD §21.3). To cut a person off entirely, revoke the membership too
// (members-update).
//
// POST {appId, userId, installationId} → {installation:{id, revokedAt}, revokedGrants, alreadyRevoked}
import { audit } from "../_shared/audit.ts";
import { isAppAdmin, loadLiveApp, loadMembership } from "../_shared/credentialAccess.ts";
import { serviceClient } from "../_shared/db.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const userId = uuid(body, "userId");
    const installationId = uuid(body, "installationId");

    await enforceRateLimit(`devices-revoke:${user.id}`, 120, 3600);
    const app = await loadLiveApp(appId);
    const self = userId === user.id;
    if (!self && !(await isAppAdmin(app, user.id))) {
      if (await loadMembership(appId, user.id))
        throw new HttpError("FORBIDDEN", "Only app admins can revoke other people's devices");
      throw new HttpError("NOT_FOUND", "App not found");
    }

    const db = serviceClient();
    const found = await db
      .from("installations")
      .select("id, revoked_at")
      .eq("id", installationId)
      .eq("app_id", appId)
      .eq("user_id", userId)
      .maybeSingle();
    if (found.error) throw new Error(`load installation failed: ${found.error.message}`);
    if (!found.data) throw new HttpError("NOT_FOUND", "Installation not found");
    if (found.data.revoked_at) {
      return {
        installation: { id: installationId, revokedAt: found.data.revoked_at },
        revokedGrants: 0,
        alreadyRevoked: true,
      };
    }

    const now = new Date().toISOString();
    const updated = await db
      .from("installations")
      .update({ revoked_at: now, revoked_by: user.id })
      .eq("id", installationId)
      .is("revoked_at", null)
      .select("revoked_at")
      .maybeSingle();
    if (updated.error) throw new Error(`revoke installation failed: ${updated.error.message}`);
    const revokedAt = (updated.data?.revoked_at as string | undefined) ?? now;

    const grants = await db
      .from("key_grants")
      .update({ revoked_at: now })
      .eq("installation_id", installationId)
      .is("revoked_at", null)
      .gt("expires_at", now)
      .select("id");
    if (grants.error) throw new Error(`revoke grants failed: ${grants.error.message}`);
    const revokedGrants = grants.data?.length ?? 0;

    await audit({
      action: "credential.revoke",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `installation:${installationId}`,
      details: { kind: "installation", userId, self, grantsRevoked: revokedGrants },
      req,
    });

    return {
      installation: { id: installationId, revokedAt },
      revokedGrants,
      alreadyRevoked: false,
    };
  }),
);
