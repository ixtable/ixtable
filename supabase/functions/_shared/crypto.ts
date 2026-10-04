// Cryptography for ixtable Cloud, using WebCrypto primitives only (PRD §21.3,
// §27.2: no custom algorithms). Formats are documented in
// docs/decisions/cloud-security-model.md.
//
// - Ed25519 sign/verify. Private keys are PKCS8 DER base64, public keys SPKI
//   DER base64 (the raw 32-byte key is the last 32 bytes of the SPKI DER).
// - AES-256-GCM key wrapping with a versioned KEK (`IXTABLE_KEK_V<n>`, 32
//   random bytes base64). Wrapped form: base64(iv[12] || ciphertext+tag).
// - HMAC-SHA256 and SHA-256 as lowercase hex.

const encoder = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

function toBytes(data: string | Uint8Array): Bytes {
  return typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
}

export function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function b64decode(value: string): Bytes {
  const binary = atob(value.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function b64urlEncode(bytes: Uint8Array): string {
  return b64encode(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Bytes {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return b64decode(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Cryptographically random bytes. */
export function randomBytes(length: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Random URL-safe token (default 32 bytes → 43 chars). */
export function randomToken(bytes = 32): string {
  return b64urlEncode(randomBytes(bytes));
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(data))));
}

export async function hmacSha256Hex(
  secret: string | Uint8Array,
  message: string | Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, toBytes(message))));
}

/** Constant-time string comparison (for tokens, signatures, hashes). */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

/** PKCE S256: base64url(sha256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlEncode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))),
  );
}

// Ed25519 ------------------------------------------------------------------

export async function importEd25519PrivateKey(pkcs8B64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", b64decode(pkcs8B64), { name: "Ed25519" }, false, [
    "sign",
  ]);
}

export async function importEd25519PublicKey(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", b64decode(spkiB64), { name: "Ed25519" }, true, ["verify"]);
}

/** Signs `data` (UTF-8 for strings); returns the 64-byte signature as base64. */
export async function signEd25519(
  privateKeyPkcs8B64: string,
  data: string | Uint8Array,
): Promise<string> {
  const key = await importEd25519PrivateKey(privateKeyPkcs8B64);
  return b64encode(
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, toBytes(data))),
  );
}

export async function verifyEd25519(
  publicKeySpkiB64: string,
  data: string | Uint8Array,
  signatureB64: string,
): Promise<boolean> {
  try {
    const key = await importEd25519PublicKey(publicKeySpkiB64);
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      b64decode(signatureB64),
      toBytes(data),
    );
  } catch {
    return false;
  }
}

export interface Ed25519KeyPair {
  privateKeyPkcs8: string;
  publicKeySpki: string;
  publicKeyRaw: string;
}

export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    privateKeyPkcs8: b64encode(
      new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    ),
    publicKeySpki: b64encode(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))),
    publicKeyRaw: b64encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
  };
}

/** Signs with `IXTABLE_CLOUD_SIGNING_KEY` (PKCS8 base64). */
export async function signWithCloudKey(data: string | Uint8Array): Promise<string> {
  const key = Deno.env.get("IXTABLE_CLOUD_SIGNING_KEY");
  if (!key) throw new Error("Missing required environment variable IXTABLE_CLOUD_SIGNING_KEY");
  return signEd25519(key, data);
}

/**
 * Deterministic JSON: object keys sorted, no whitespace. Sign
 * `canonicalJson(manifest)` and send that exact string, so the verifier
 * checks the same bytes without re-serializing.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * Bundle fingerprint (PRD §21.2): HMAC-SHA256(IXTABLE_FINGERPRINT_SECRET,
 * "userId|versionId|installationId|issuedAt") as hex.
 */
export async function bundleFingerprint(
  userId: string,
  versionId: string,
  installationId: string,
  issuedAt: string,
  secret = Deno.env.get("IXTABLE_FINGERPRINT_SECRET"),
): Promise<string> {
  if (!secret) throw new Error("Missing required environment variable IXTABLE_FINGERPRINT_SECRET");
  return hmacSha256Hex(secret, [userId, versionId, installationId, issuedAt].join("|"));
}

// AES-256-GCM ---------------------------------------------------------------

async function aesKey(keyBytes: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  if (keyBytes.byteLength !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes),
    { name: "AES-GCM" },
    false,
    usage,
  );
}

/** AES-256-GCM encrypt; returns base64(iv[12] || ciphertext+tag). */
export async function aesGcmEncrypt(
  keyBytes: Uint8Array,
  plaintext: Uint8Array,
  aad?: string,
): Promise<string> {
  const iv = randomBytes(12);
  const key = await aesKey(keyBytes, ["encrypt"]);
  const params: AesGcmParams = {
    name: "AES-GCM",
    iv,
    ...(aad ? { additionalData: encoder.encode(aad) } : {}),
  };
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(params, key, new Uint8Array(plaintext)),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return b64encode(out);
}

/** Inverse of aesGcmEncrypt. Throws on a wrong key, wrong AAD or tampering. */
export async function aesGcmDecrypt(
  keyBytes: Uint8Array,
  sealedB64: string,
  aad?: string,
): Promise<Bytes> {
  const sealed = b64decode(sealedB64);
  if (sealed.length < 12 + 16) throw new Error("Sealed value is too short");
  const key = await aesKey(keyBytes, ["decrypt"]);
  const params: AesGcmParams = {
    name: "AES-GCM",
    iv: sealed.slice(0, 12),
    ...(aad ? { additionalData: encoder.encode(aad) } : {}),
  };
  return new Uint8Array(await crypto.subtle.decrypt(params, key, sealed.slice(12)));
}

/** KEK for `version` from `IXTABLE_KEK_V<version>` (32 bytes, base64). */
export function kekBytes(version: number): Bytes {
  const value = Deno.env.get(`IXTABLE_KEK_V${version}`);
  if (!value) throw new Error(`Missing KEK version ${version}`);
  const bytes = b64decode(value);
  if (bytes.length !== 32) throw new Error(`KEK version ${version} must be 32 bytes`);
  return bytes;
}

/** Version used for new wraps: `IXTABLE_KEK_CURRENT_VERSION`, default 1. */
export function currentKekVersion(): number {
  const value = Number(Deno.env.get("IXTABLE_KEK_CURRENT_VERSION") ?? "1");
  if (!Number.isInteger(value) || value < 1)
    throw new Error("IXTABLE_KEK_CURRENT_VERSION must be a positive integer");
  return value;
}

/**
 * Wraps a data-encryption key with the current KEK. Pass `aad` (for example
 * `${appId}|${datasourceId}`) to bind the wrapped key to its envelope.
 */
export async function wrapDek(
  dek: Uint8Array,
  aad?: string,
): Promise<{ wrappedDek: string; kekVersion: number }> {
  const kekVersion = currentKekVersion();
  return { wrappedDek: await aesGcmEncrypt(kekBytes(kekVersion), dek, aad), kekVersion };
}

export async function unwrapDek(
  wrappedDek: string,
  kekVersion: number,
  aad?: string,
): Promise<Bytes> {
  return aesGcmDecrypt(kekBytes(kekVersion), wrappedDek, aad);
}
