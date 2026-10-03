// Pure helpers for credential envelopes, key grants and the desktop sign-in
// hand-off (PRD §21.3). No I/O here, so everything is unit tested in
// credentials_test.ts. Formats: docs/decisions/cloud-security-model.md.
import { b64decode } from "./crypto.ts";
import { HttpError } from "./http.ts";

type Body = Record<string, unknown>;

/** Datasource ids are desktop ids (uuid or slug); `|` is excluded so the AAD stays unambiguous. */
export const DATASOURCE_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
/** PKCE S256 challenge: base64url of a SHA-256 digest, no padding. */
export const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1 code_verifier. */
export const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
/** Opaque desktop-generated state, URL-safe. */
export const STATE_RE = /^[A-Za-z0-9._~-]{16,200}$/;

/** XChaCha20-Poly1305 (Studio) uses a 24-byte nonce and a 16-byte tag. */
export const XCHACHA_NONCE_BYTES = 24;
export const AEAD_TAG_BYTES = 16;
/** Datasource secret JSON is small; 64 KiB of ciphertext is plenty. */
export const MAX_CIPHERTEXT_BYTES = 65_536;
export const MAX_AAD_BYTES = 1_024;
export const DEK_BYTES = 32;

/** Key grants live 24 hours (PRD §21.3). */
export const GRANT_TTL_MS = 24 * 60 * 60 * 1000;
/** Approved desktop sign-in requests must be redeemed within 5 minutes. */
export const DESKTOP_AUTH_TTL_MS = 5 * 60 * 1000;
/** Wrong verifiers tolerated before a desktop sign-in request is invalidated. */
export const DESKTOP_AUTH_MAX_FAILURES = 5;

export type EnvelopeScope = "shared" | "user";

/**
 * AES-GCM additional data for the wrapped DEK. Binds the wrapped key to its
 * target so a row copied to another app, datasource or user fails to unwrap.
 */
export function envelopeAad(
  appId: string,
  datasourceId: string,
  scope: EnvelopeScope,
  userId: string | null,
): string {
  return [appId, datasourceId, scope, scope === "user" ? (userId ?? "") : ""].join("|");
}

function fail(field: string, message: string): never {
  throw new HttpError("VALIDATION", `${field}: ${message}`, { field });
}

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Reads a standard base64 field and checks its decoded length. Returns the
 * normalized base64 string and the bytes. Empty strings are allowed only
 * when `min` is 0.
 */
export function base64Field(
  body: Body,
  key: string,
  o: { min?: number; max?: number; exact?: number } = {},
): { value: string; bytes: Uint8Array } {
  const raw = body[key];
  if (raw === undefined || raw === null) fail(key, "is required");
  if (typeof raw !== "string") fail(key, "must be a base64 string");
  const value = raw.trim();
  if (!B64_RE.test(value)) fail(key, "must be standard base64");
  const bytes = b64decode(value);
  if (o.exact !== undefined && bytes.length !== o.exact)
    fail(key, `must decode to ${o.exact} bytes`);
  if (bytes.length < (o.min ?? 1)) fail(key, `must decode to at least ${o.min ?? 1} bytes`);
  if (o.max !== undefined && bytes.length > o.max)
    fail(key, `must decode to at most ${o.max} bytes`);
  return { value, bytes };
}

export function datasourceId(body: Body, key = "datasourceId"): string {
  const value = body[key];
  if (typeof value !== "string" || !DATASOURCE_ID_RE.test(value))
    fail(key, "must be 1-200 characters of A-Z a-z 0-9 . _ : -");
  return value;
}

export function grantExpiry(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + GRANT_TTL_MS);
}

/** A grant counts for renewal while it is unexpired and not revoked. */
export function isLiveGrant(
  grant: { expires_at: string; revoked_at: string | null },
  now = new Date(),
): boolean {
  return grant.revoked_at === null && new Date(grant.expires_at).getTime() > now.getTime();
}

export type DesktopAuthState = "pending" | "expired" | "consumed" | "ready";

/** Classifies a desktop_auth_requests row (or its absence) for desktop-auth-exchange. */
export function desktopAuthState(
  row: { approved_at: string | null; expires_at: string; consumed_at: string | null } | null,
  now = new Date(),
): DesktopAuthState {
  if (!row || !row.approved_at) return "pending";
  if (row.consumed_at) return "consumed";
  if (new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  return "ready";
}
