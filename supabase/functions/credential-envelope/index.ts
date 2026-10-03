// Stores a datasource credential envelope (PRD §21.3). Studio encrypts the
// secret with a random DEK (XChaCha20-Poly1305) and sends the ciphertext and
// the DEK; this function wraps the DEK with the KEK (AES-256-GCM, AAD bound to
// the target) and keeps only the wrapped form. Owner only. A new upload
// supersedes the target's previous envelope and erases its secret material.
//
// POST {appId, datasourceId, scope:"shared"|"user", userId?, ciphertext, nonce, aad, dek}
//   → {envelopeId, replacedEnvelopeId, kekVersion}
import { audit } from "../_shared/audit.ts";
import { loadLiveApp, loadMembership, requireAppOwner } from "../_shared/credentialAccess.ts";
import {
  AEAD_TAG_BYTES,
  base64Field,
  DEK_BYTES,
  datasourceId as readDatasourceId,
  envelopeAad,
  MAX_AAD_BYTES,
  MAX_CIPHERTEXT_BYTES,
  XCHACHA_NONCE_BYTES,
} from "../_shared/credentials.ts";
import { wrapDek } from "../_shared/crypto.ts";
import { serviceClient } from "../_shared/db.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { oneOf, uuid } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const appId = uuid(body, "appId");
    const datasourceId = readDatasourceId(body);
    const scope = oneOf(body, "scope", ["shared", "user"] as const);
    const targetUserId = uuid(body, "userId", { optional: true }) ?? null;
    if (scope === "user" && !targetUserId)
      throw new HttpError("VALIDATION", "userId: is required for scope user", { field: "userId" });
    if (scope === "shared" && targetUserId)
      throw new HttpError("VALIDATION", "userId: must be omitted for scope shared", {
        field: "userId",
      });
    const ciphertext = base64Field(body, "ciphertext", {
      min: AEAD_TAG_BYTES + 1,
      max: MAX_CIPHERTEXT_BYTES,
    });
    const nonce = base64Field(body, "nonce", { exact: XCHACHA_NONCE_BYTES });
    const aad = base64Field(body, "aad", { min: 0, max: MAX_AAD_BYTES });
    const dek = base64Field(body, "dek", { exact: DEK_BYTES });

    await enforceNamedRateLimit("credential-envelope", user.id);
    const app = await loadLiveApp(appId);
    await requireAppOwner(app, user.id);

    if (scope === "user") {
      const member = await loadMembership(appId, targetUserId!);
      if (member?.status !== "active" && targetUserId !== app.owner_id) {
        throw new HttpError("VALIDATION", "userId: is not an active member of this app", {
          field: "userId",
        });
      }
    }

    const { wrappedDek, kekVersion } = await wrapDek(
      dek.bytes,
      envelopeAad(appId, datasourceId, scope, targetUserId),
    );
    dek.bytes.fill(0);

    const { data, error } = await serviceClient().rpc("credential_envelope_put", {
      p_app_id: appId,
      p_datasource_id: datasourceId,
      p_scope: scope,
      p_user_id: targetUserId,
      p_ciphertext: ciphertext.value,
      p_nonce: nonce.value,
      p_aad: aad.value,
      p_wrapped_dek: wrappedDek,
      p_kek_version: kekVersion,
      p_created_by: user.id,
    });
    if (error) throw new Error(`credential_envelope_put failed: ${error.message}`);
    const result = data as { id: string; replacedId: string | null };

    await audit({
      action: "credential.upload",
      actorId: user.id,
      orgId: app.org_id,
      appId,
      target: `datasource:${datasourceId}`,
      details: {
        envelopeId: result.id,
        replacedEnvelopeId: result.replacedId,
        scope,
        userId: targetUserId,
        kekVersion,
      },
      req,
    });
    await incrementMetric("credential.upload");

    return { envelopeId: result.id, replacedEnvelopeId: result.replacedId, kekVersion };
  }),
);
