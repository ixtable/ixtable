import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  b64decode,
  b64encode,
  b64urlDecode,
  b64urlEncode,
  bundleFingerprint,
  canonicalJson,
  generateEd25519KeyPair,
  hmacSha256Hex,
  pkceChallenge,
  randomBytes,
  randomToken,
  sha256Hex,
  signEd25519,
  timingSafeEqual,
  unwrapDek,
  verifyEd25519,
  wrapDek,
} from "./crypto.ts";

Deno.test("sha256Hex and hmacSha256Hex match published vectors", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  // RFC 4231 test case 2.
  assertEquals(
    await hmacSha256Hex("Jefe", "what do ya want for nothing?"),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});

Deno.test("pkceChallenge is base64url(sha256(verifier))", async () => {
  assertEquals(
    await pkceChallenge("dBjftJeZ4CVP-mJ92ZcpTd1ofzvSlD3ITOhF8n0ZT6M"),
    // node: createHash("sha256").update(verifier).digest("base64url")
    "Td4Kctw30xvAGU1HXdS2gZaMT8-NlZt9QqSICpJCXO8",
  );
});

Deno.test("base64 helpers round-trip and tokens are url-safe", () => {
  const bytes = randomBytes(33);
  assertEquals(b64decode(b64encode(bytes)), bytes);
  assertEquals(b64urlDecode(b64urlEncode(bytes)), bytes);
  const token = randomToken();
  assertEquals(token.length, 43);
  assert(/^[A-Za-z0-9_-]+$/.test(token));
  assertNotEquals(randomToken(), token);
});

Deno.test("timingSafeEqual compares exactly", () => {
  assert(timingSafeEqual("abc", "abc"));
  assert(!timingSafeEqual("abc", "abd"));
  assert(!timingSafeEqual("abc", "abcd"));
});

Deno.test("Ed25519 signs and verifies; tampering and wrong keys fail", async () => {
  const pair = await generateEd25519KeyPair();
  // SPKI DER = 12-byte Ed25519 prefix + raw key (what the desktop pins).
  assertEquals(b64encode(b64decode(pair.publicKeySpki).slice(12)), pair.publicKeyRaw);
  const message = canonicalJson({ b: 1, a: "x" });
  const signature = await signEd25519(pair.privateKeyPkcs8, message);
  assertEquals(b64decode(signature).length, 64);
  assert(await verifyEd25519(pair.publicKeySpki, message, signature));
  assert(!(await verifyEd25519(pair.publicKeySpki, `${message} `, signature)));
  const other = await generateEd25519KeyPair();
  assert(!(await verifyEd25519(other.publicKeySpki, message, signature)));
  assert(!(await verifyEd25519("not-a-key", message, signature)));
});

Deno.test("Ed25519 interoperates with Node-generated PKCS8/SPKI keys (dev-secrets.mjs format)", async () => {
  // Test-only key from node:crypto generateKeyPairSync("ed25519"), DER base64,
  // and Node's signature over "hello". Ed25519 signatures are deterministic.
  const pkcs8 = "MC4CAQAwBQYDK2VwBCIEICpbrfQl+EqdjB9GSJ+kQEsdJHW0wwCt+iHoJwUFnOUg";
  const spki = "MCowBQYDK2VwAyEAV7c7vvN077UsQZfkbMYceDzxzQEmbbuKvAoLHovRco0=";
  const nodeSignature =
    "N1VT++vq2IJrJHKkFl13WfagbDVZlWNP7EI7XrBetiyP7w2DTT7XSuGVpHuIQD2msAnn1JFhuaeBA4DoBy54Dg==";
  assert(await verifyEd25519(spki, "hello", nodeSignature));
  assertEquals(await signEd25519(pkcs8, "hello"), nodeSignature);
});

Deno.test("canonicalJson sorts keys, drops undefined, keeps arrays in order", () => {
  assertEquals(
    canonicalJson({ z: [3, { y: 1, x: null }], a: "é", u: undefined }),
    '{"a":"é","z":[3,{"x":null,"y":1}]}',
  );
});

Deno.test("AES-256-GCM seals and rejects wrong key, wrong AAD and tampering", async () => {
  const key = randomBytes(32);
  const sealed = await aesGcmEncrypt(key, new TextEncoder().encode("secret"), "app|ds");
  assertEquals(new TextDecoder().decode(await aesGcmDecrypt(key, sealed, "app|ds")), "secret");
  await assertRejects(() => aesGcmDecrypt(randomBytes(32), sealed, "app|ds"));
  await assertRejects(() => aesGcmDecrypt(key, sealed, "other"));
  const bytes = b64decode(sealed);
  bytes[bytes.length - 1] ^= 1;
  await assertRejects(() => aesGcmDecrypt(key, b64encode(bytes), "app|ds"));
  await assertRejects(() => aesGcmEncrypt(randomBytes(16), new Uint8Array(1)));
});

Deno.test("wrapDek/unwrapDek use the versioned KEK from the environment", async () => {
  Deno.env.set("IXTABLE_KEK_V1", b64encode(randomBytes(32)));
  Deno.env.set("IXTABLE_KEK_V2", b64encode(randomBytes(32)));
  Deno.env.set("IXTABLE_KEK_CURRENT_VERSION", "2");
  const dek = randomBytes(32);
  const { wrappedDek, kekVersion } = await wrapDek(dek, "app|ds");
  assertEquals(kekVersion, 2);
  assertEquals(await unwrapDek(wrappedDek, 2, "app|ds"), dek);
  await assertRejects(() => unwrapDek(wrappedDek, 1, "app|ds"));
  await assertRejects(() => unwrapDek(wrappedDek, 3, "app|ds"));
  Deno.env.delete("IXTABLE_KEK_CURRENT_VERSION");
});

Deno.test("bundleFingerprint is HMAC over userId|versionId|installationId|issuedAt", async () => {
  const value = await bundleFingerprint("u", "v", "i", "2026-01-01T00:00:00Z", "secret");
  assertEquals(value, await hmacSha256Hex("secret", "u|v|i|2026-01-01T00:00:00Z"));
  assertNotEquals(value, await bundleFingerprint("u", "v", "i2", "2026-01-01T00:00:00Z", "secret"));
});
