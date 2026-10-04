/**
 * Seeding and crypto helpers shared by the credential, key-grant and
 * revocation specs. Studio's side of envelope encryption is reproduced with
 * XChaCha20-Poly1305 (@noble/ciphers), the same AEAD the desktop uses, so a
 * spec proves the DEK returned by key-grant really opens the ciphertext.
 */
import { randomBytes } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { callFunction, getServiceClient } from "../clients";
import type { CloudFixture } from "../fixture";
import {
  type AppRow,
  addMember,
  createInstallation,
  createRole,
  grantSubscription,
  type TestUser,
} from "../seed";

export interface SealedSecret {
  ciphertext: string;
  nonce: string;
  aad: string;
  dek: string;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Encrypts `secret` as Studio does: random 32-byte DEK, 24-byte nonce. */
export function sealSecret(secret: unknown, aadText = "ixtable-datasource"): SealedSecret {
  const dek = randomBytes(32);
  const nonce = randomBytes(24);
  const aad = Buffer.from(aadText);
  const ciphertext = xchacha20poly1305(dek, nonce, aad).encrypt(
    Buffer.from(JSON.stringify(secret)),
  );
  return { ciphertext: b64(ciphertext), nonce: b64(nonce), aad: b64(aad), dek: b64(dek) };
}

/** Decrypts an envelope returned by key-grant with its DEK. */
export function openSecret(
  dek: string,
  envelope: { ciphertext: string; nonce: string; aad: string },
): unknown {
  const plaintext = xchacha20poly1305(
    Buffer.from(dek, "base64"),
    Buffer.from(envelope.nonce, "base64"),
    Buffer.from(envelope.aad, "base64"),
  ).decrypt(Buffer.from(envelope.ciphertext, "base64"));
  return JSON.parse(Buffer.from(plaintext).toString("utf8"));
}

export interface CredentialWorld {
  owner: TestUser;
  member: TestUser;
  app: AppRow;
  roleId: string;
  /** The member's Runtime installation. */
  installationId: string;
}

/** Owner + entitled app + one active Runtime User with an installation. */
export async function credentialWorld(
  cloud: CloudFixture,
  opts: { plan?: "starter" | "team" | "business"; subscribe?: boolean } = {},
): Promise<CredentialWorld> {
  const owner = await cloud.user();
  const member = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner, { datasourceKind: "postgres" });
  if (opts.subscribe !== false) await grantSubscription(app.id, opts.plan ?? "team");
  const role = await createRole(app.id);
  await addMember(app.id, member.user.id, role.id);
  const installationId = await createInstallation(app.id, member.user.id);
  return { owner, member, app, roleId: role.id, installationId };
}

export async function uploadEnvelope(
  owner: TestUser,
  appId: string,
  sealed: SealedSecret,
  target: { datasourceId?: string; scope?: "shared" | "user"; userId?: string } = {},
) {
  return callFunction<{ envelopeId: string; replacedEnvelopeId: string | null }>(
    "credential-envelope",
    {
      jwt: owner.jwt,
      body: {
        appId,
        datasourceId: target.datasourceId ?? "main",
        scope: target.scope ?? "shared",
        ...(target.userId ? { userId: target.userId } : {}),
        ...sealed,
      },
    },
  );
}

export interface GrantBody {
  grantId: string;
  datasourceId: string;
  dek: string;
  envelope: { id: string; scope: string; ciphertext: string; nonce: string; aad: string };
  issuedAt: string;
  expiresAt: string;
  renewed: boolean;
}

export async function requestGrant(
  user: TestUser,
  appId: string,
  installationId: string,
  datasourceId = "main",
) {
  return callFunction<GrantBody & { error?: { code: string; message: string } }>("key-grant", {
    jwt: user.jwt,
    body: { appId, installationId, datasourceId },
  });
}

/** Audit rows for an app and action (service role; audit is append-only). */
export async function auditRows(appId: string, action: string) {
  const { data, error } = await getServiceClient()
    .from("audit_events")
    .select("action, actor_id, target, details")
    .eq("app_id", appId)
    .eq("action", action)
    .order("at", { ascending: true });
  if (error) throw new Error(`audit query failed: ${error.message}`);
  return data ?? [];
}

export async function grantRows(appId: string) {
  const { data, error } = await getServiceClient()
    .from("key_grants")
    .select("*")
    .eq("app_id", appId)
    .order("issued_at", { ascending: true });
  if (error) throw new Error(`key_grants query failed: ${error.message}`);
  return data ?? [];
}
