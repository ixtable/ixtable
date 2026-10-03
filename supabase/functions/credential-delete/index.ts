// Deletes (revokes) datasource credential envelopes. Owner only. The rows keep
// their metadata for attribution, but the ciphertext and wrapped DEK are
// erased, so later key-grant calls for the target fail with NOT_FOUND.
// Credentials a Runtime already decrypted stay valid until the developer
// rotates them in the database (PRD §21.3).
//
// POST {appId, datasourceId, scope?:"shared"|"user", userId?}
//   scope omitted: every envelope of the datasource.
//   → {revokedEnvelopeIds, revokedGrants}
import { audit } from "../_shared/audit.ts";
import { loadLiveApp, requireAppOwner } from "../_shared/credentialAccess.ts";
import { datasourceId as readDatasourceId } from "../_shared/credentials.ts";
import { serviceClient } from "../_shared/db.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { oneOf, uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const datasourceId = readDatasourceId(body);
    const scope = oneOf(body, "scope", ["shared", "user"] as const, { optional: true });
    const targetUserId = uuid(body, "userId", { optional: true }) ?? null;
    if (scope === "user" && !targetUserId)
      throw new HttpError("VALIDATION", "userId: is required for scope user", { field: "userId" });
    if (scope !== "user" && targetUserId)
      throw new HttpError("VALIDATION", "userId: is only allowed with scope user", {
        field: "userId",
      });

    await enforceRateLimit(`credential-delete:${user.id}`, 60, 3600);
    const app = await loadLiveApp(appId);
    await requireAppOwner(app, user.id);

    const db = serviceClient();
    let query = db
      .from("credential_envelopes")
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: user.id,
        ciphertext: "",
        nonce: "",
        aad: "",
        wrapped_dek: "",
      })
      .eq("app_id", appId)
      .eq("datasource_id", datasourceId)
      .is("superseded_at", null)
      .is("revoked_at", null);
    if (scope === "shared") query = query.is("user_id", null);
    if (scope === "user") query = query.eq("user_id", targetUserId!);
    const { data, error } = await query.select("id");
    if (error) throw new Error(`revoke envelopes failed: ${error.message}`);
    const revokedEnvelopeIds = (data ?? []).map((row) => row.id as string);
    if (revokedEnvelopeIds.length === 0)
      throw new HttpError("NOT_FOUND", "No credential to delete");

    const grants = await db
      .from("key_grants")
      .update({ revoked_at: new Date().toISOString() })
      .in("envelope_id", revokedEnvelopeIds)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("id");
    if (grants.error) throw new Error(`revoke grants failed: ${grants.error.message}`);

    await audit({
      action: "credential.revoke",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `datasource:${datasourceId}`,
      details: {
        kind: "envelope",
        envelopeIds: revokedEnvelopeIds,
        scope: scope ?? "all",
        userId: targetUserId,
        grantsRevoked: grants.data?.length ?? 0,
      },
      req,
    });

    return { revokedEnvelopeIds, revokedGrants: grants.data?.length ?? 0 };
  }),
);
