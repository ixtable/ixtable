// Issues a short-lived key grant for a datasource credential (PRD §21.3).
// Checks, in order: session, input, rate limit (30/hour per user and app),
// live app, owner or active member (REVOKED when revoked), the caller's
// installation (REVOKED when revoked), entitlement, then the envelope (the
// caller's per-user envelope wins over the shared one). Returns the unwrapped
// DEK once, records a key_grants row and audits key.issue or key.renew (a
// live grant already existed for this installation and datasource).
//
// POST {appId, installationId, datasourceId}
//   → {grantId, datasourceId, dek, envelope:{id, scope, ciphertext, nonce, aad},
//      issuedAt, expiresAt, renewed}
import { audit } from "../_shared/audit.ts";
import { loadLiveApp, loadMembership } from "../_shared/credentialAccess.ts";
import {
  datasourceId as readDatasourceId,
  envelopeAad,
  type EnvelopeScope,
  grantExpiry,
  isLiveGrant,
} from "../_shared/credentials.ts";
import { b64encode, unwrapDek } from "../_shared/crypto.ts";
import { serviceClient } from "../_shared/db.ts";
import { requireEntitlement } from "../_shared/entitlements.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { uuid } from "../_shared/validate.ts";

interface EnvelopeRow {
  id: string;
  scope: EnvelopeScope;
  user_id: string | null;
  ciphertext: string;
  nonce: string;
  aad: string;
  wrapped_dek: string;
  kek_version: number;
}

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const installationId = uuid(body, "installationId");
    const datasourceId = readDatasourceId(body);

    await enforceRateLimit(`key-grant:${user.id}:${appId}`, 30, 3600);
    const app = await loadLiveApp(appId);
    const db = serviceClient();

    if (app.owner_id !== user.id) {
      const member = await loadMembership(appId, user.id);
      if (!member) throw new HttpError("NOT_FOUND", "App not found");
      if (member.status !== "active")
        throw new HttpError("REVOKED", "Your access to this app was revoked");
    }

    const installation = await db
      .from("installations")
      .select("id, revoked_at")
      .eq("id", installationId)
      .eq("app_id", appId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (installation.error)
      throw new Error(`load installation failed: ${installation.error.message}`);
    if (!installation.data) throw new HttpError("NOT_FOUND", "Installation not found");
    if (installation.data.revoked_at)
      throw new HttpError("REVOKED", "This device was revoked for this app");

    await requireEntitlement(appId);

    const envelopes = await db
      .from("credential_envelopes")
      .select("id, scope, user_id, ciphertext, nonce, aad, wrapped_dek, kek_version")
      .eq("app_id", appId)
      .eq("datasource_id", datasourceId)
      .is("superseded_at", null)
      .is("revoked_at", null)
      .or(`user_id.is.null,user_id.eq.${user.id}`);
    if (envelopes.error) throw new Error(`load envelope failed: ${envelopes.error.message}`);
    const rows = (envelopes.data ?? []) as EnvelopeRow[];
    const envelope =
      rows.find((row) => row.scope === "user") ?? rows.find((row) => row.scope === "shared");
    if (!envelope)
      throw new HttpError("NOT_FOUND", "No credential is published for this datasource");

    const dek = await unwrapDek(
      envelope.wrapped_dek,
      envelope.kek_version,
      envelopeAad(appId, datasourceId, envelope.scope, envelope.user_id),
    );

    const previous = await db
      .from("key_grants")
      .select("id, expires_at, revoked_at")
      .eq("installation_id", installationId)
      .eq("datasource_id", datasourceId)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (previous.error) throw new Error(`load grants failed: ${previous.error.message}`);
    const renewedFrom =
      previous.data && isLiveGrant(previous.data) ? (previous.data.id as string) : null;

    const issuedAt = new Date();
    const expiresAt = grantExpiry(issuedAt);
    const grant = await db
      .from("key_grants")
      .insert({
        app_id: appId,
        envelope_id: envelope.id,
        user_id: user.id,
        installation_id: installationId,
        datasource_id: datasourceId,
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        used_at: issuedAt.toISOString(),
        renewed_from: renewedFrom,
        kind: renewedFrom ? "renew" : "issue",
      })
      .select("id")
      .single();
    if (grant.error) throw new Error(`insert grant failed: ${grant.error.message}`);
    const grantId = grant.data.id as string;

    await db
      .from("installations")
      .update({ last_seen_at: issuedAt.toISOString() })
      .eq("id", installationId);

    await audit({
      action: renewedFrom ? "key.renew" : "key.issue",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `installation:${installationId}`,
      details: {
        grantId,
        datasourceId,
        envelopeId: envelope.id,
        scope: envelope.scope,
        renewedFrom,
        expiresAt: expiresAt.toISOString(),
      },
      req,
    });
    await incrementMetric(renewedFrom ? "key.renew" : "key.issue");

    return {
      grantId,
      datasourceId,
      dek: b64encode(dek),
      envelope: {
        id: envelope.id,
        scope: envelope.scope,
        ciphertext: envelope.ciphertext,
        nonce: envelope.nonce,
        aad: envelope.aad,
      },
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      renewed: renewedFrom !== null,
    };
  }),
);
