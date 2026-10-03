import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  base64Field,
  datasourceId,
  desktopAuthState,
  envelopeAad,
  GRANT_TTL_MS,
  grantExpiry,
  isLiveGrant,
  CODE_CHALLENGE_RE,
  CODE_VERIFIER_RE,
  STATE_RE,
} from "./credentials.ts";
import { b64encode, pkceChallenge, unwrapDek, wrapDek } from "./crypto.ts";
import { HttpError } from "./http.ts";

const APP = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const USER = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";

Deno.test("envelopeAad binds app, datasource, scope and user", () => {
  assertEquals(envelopeAad(APP, "main", "shared", null), `${APP}|main|shared|`);
  assertEquals(envelopeAad(APP, "main", "shared", USER), `${APP}|main|shared|`);
  assertEquals(envelopeAad(APP, "main", "user", USER), `${APP}|main|user|${USER}`);
});

Deno.test("a DEK wrapped for one target does not unwrap for another", async () => {
  Deno.env.set("IXTABLE_KEK_V1", b64encode(crypto.getRandomValues(new Uint8Array(32))));
  Deno.env.set("IXTABLE_KEK_CURRENT_VERSION", "1");
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const aad = envelopeAad(APP, "main", "user", USER);
  const { wrappedDek, kekVersion } = await wrapDek(dek, aad);
  assertEquals(await unwrapDek(wrappedDek, kekVersion, aad), dek);
  let failed = false;
  try {
    await unwrapDek(wrappedDek, kekVersion, envelopeAad(APP, "main", "shared", null));
  } catch {
    failed = true;
  }
  assertEquals(failed, true);
});

Deno.test("base64Field checks encoding and decoded length", () => {
  const nonce = b64encode(new Uint8Array(24));
  assertEquals(base64Field({ nonce }, "nonce", { exact: 24 }).bytes.length, 24);
  assertEquals(base64Field({ aad: "" }, "aad", { min: 0 }).value, "");
  const cases: Record<string, unknown>[] = [
    {},
    { nonce: 42 },
    { nonce: "not base64!" },
    { nonce: b64encode(new Uint8Array(12)) },
    { nonce: "" },
  ];
  for (const body of cases) {
    const err = assertThrows(() => base64Field(body, "nonce", { exact: 24 }), HttpError);
    assertEquals(err.code, "VALIDATION");
  }
  assertThrows(() => base64Field({ c: b64encode(new Uint8Array(10)) }, "c", { max: 8 }), HttpError);
});

Deno.test("datasourceId rejects separators and empty values", () => {
  assertEquals(datasourceId({ datasourceId: "main" }), "main");
  assertEquals(datasourceId({ datasourceId: APP }), APP);
  for (const value of ["", "a|b", 7, "x".repeat(201)]) {
    assertThrows(() => datasourceId({ datasourceId: value }), HttpError);
  }
});

Deno.test("grant expiry is 24 hours and liveness respects revocation", () => {
  const now = new Date("2026-10-03T00:00:00.000Z");
  assertEquals(grantExpiry(now).getTime() - now.getTime(), GRANT_TTL_MS);
  const live = { expires_at: "2026-10-03T01:00:00.000Z", revoked_at: null };
  assertEquals(isLiveGrant(live, now), true);
  assertEquals(isLiveGrant({ ...live, revoked_at: "2026-10-02T00:00:00.000Z" }, now), false);
  assertEquals(isLiveGrant({ ...live, expires_at: "2026-10-02T23:59:59.000Z" }, now), false);
});

Deno.test("desktopAuthState classifies requests", () => {
  const now = new Date("2026-10-03T00:00:00.000Z");
  const ready = {
    approved_at: "2026-10-02T23:59:00.000Z",
    expires_at: "2026-10-03T00:04:00.000Z",
    consumed_at: null,
  };
  assertEquals(desktopAuthState(null, now), "pending");
  assertEquals(desktopAuthState({ ...ready, approved_at: null }, now), "pending");
  assertEquals(desktopAuthState(ready, now), "ready");
  assertEquals(desktopAuthState({ ...ready, consumed_at: ready.approved_at }, now), "consumed");
  assertEquals(desktopAuthState({ ...ready, expires_at: ready.approved_at }, now), "expired");
});

Deno.test("PKCE patterns accept RFC 7636 values", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = await pkceChallenge(verifier);
  assertEquals(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assertEquals(CODE_CHALLENGE_RE.test(challenge), true);
  assertEquals(CODE_VERIFIER_RE.test(verifier), true);
  assertEquals(CODE_VERIFIER_RE.test("short"), false);
  assertEquals(STATE_RE.test("abcdefghijklmnop"), true);
  assertEquals(STATE_RE.test("has space in it!!"), false);
});
