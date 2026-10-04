/**
 * Contract: desktop sign-in hand-off (PKCE S256). The signed-in website calls
 * desktop-auth-approve with the desktop's code_challenge and state; the
 * desktop redeems the request once with desktop-auth-exchange and its
 * code_verifier, without a session of its own.
 */
import { createHash, randomBytes } from "node:crypto";
import { callFunction, getAnonClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import type { TestUser } from "../seed";

interface ExchangeBody {
  session?: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    expires_in: number;
    token_type: string;
    user: { id: string; email: string };
  };
  error?: { code: string; message: string; details?: { reason?: string } };
}

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(18).toString("base64url"),
  };
}

const approve = (user: TestUser | null, codeChallenge: string, state: string) =>
  callFunction<{ ok?: boolean; expiresAt?: string; error?: { code: string } }>(
    "desktop-auth-approve",
    { jwt: user?.jwt, body: { codeChallenge, state } },
  );

const exchange = (state: string, codeVerifier: string) =>
  callFunction<ExchangeBody>("desktop-auth-exchange", { body: { state, codeVerifier } });

test("an approved request exchanges for a working session", async ({ cloud }) => {
  const user = await cloud.user();
  const { verifier, challenge, state } = pkcePair();

  const pending = await exchange(state, verifier);
  const approved = await approve(user, challenge, state);
  const result = await exchange(state, verifier);

  expect(pending.status).toBe(428);
  expect(pending.body.error?.code).toBe("PENDING");
  expect(approved.status).toBe(200);
  expect(Date.parse(approved.body.expiresAt ?? "") - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  expect(result.status).toBe(200);
  expect(result.body.session?.user).toEqual({ id: user.user.id, email: user.email });

  const desktop = getAnonClient();
  const set = await desktop.auth.setSession({
    access_token: result.body.session!.access_token,
    refresh_token: result.body.session!.refresh_token,
  });
  expect(set.error).toBeNull();
  const profiles = await desktop.from("profiles").select("id, email");
  expect(profiles.data).toEqual([{ id: user.user.id, email: user.email }]);
  const { data: audit } = await cloud.admin
    .from("audit_events")
    .select("action")
    .eq("actor_id", user.user.id)
    .eq("action", "auth.desktop_exchange");
  expect(audit).toHaveLength(1);
  await desktop.auth.signOut();

  recordOutcome("desktop-auth-01-approve-and-exchange", {
    expectations: [
      "Before approval the exchange returns 428 PENDING; after the signed-in user approves, it returns 200 with a session for that user.",
      "The returned session works: an RLS-protected select on profiles returns exactly the user's own row.",
      "One auth.desktop_exchange audit event is recorded for the user.",
    ],
    details: {
      pending: pending.body,
      approved: approved.body,
      sessionUser: result.body.session?.user,
      profileRows: profiles.data?.length,
    },
  });
});

test("a request can be exchanged only once", async ({ cloud }) => {
  const user = await cloud.user();
  const { verifier, challenge, state } = pkcePair();
  await approve(user, challenge, state);

  const first = await exchange(state, verifier);
  const second = await exchange(state, verifier);
  const reapprove = await approve(user, challenge, state);

  expect(first.status).toBe(200);
  expect(second.status).toBe(404);
  expect(second.body.error).toMatchObject({ code: "NOT_FOUND", details: { reason: "consumed" } });
  expect(reapprove.status).toBe(422);

  recordOutcome("desktop-auth-02-single-use", {
    expectations: [
      "The second exchange of the same state returns 404 NOT_FOUND with reason consumed and no session.",
      "Approving a consumed state again is refused with 422 VALIDATION.",
    ],
    details: { second: second.body, reapprove: reapprove.body },
  });
});

test("a wrong verifier is refused and does not consume the request", async ({ cloud }) => {
  const user = await cloud.user();
  const { verifier, challenge, state } = pkcePair();
  await approve(user, challenge, state);

  const wrong = await exchange(state, pkcePair().verifier);
  const { data: row } = await cloud.admin
    .from("desktop_auth_requests")
    .select("failed_attempts, consumed_at")
    .eq("state", state)
    .single();
  const right = await exchange(state, verifier);

  expect(wrong.status).toBe(403);
  expect(wrong.body.error).toMatchObject({
    code: "FORBIDDEN",
    details: { reason: "verifier_mismatch" },
  });
  expect(wrong.body.session).toBeUndefined();
  expect(row).toEqual({ failed_attempts: 1, consumed_at: null });
  expect(right.status).toBe(200);

  recordOutcome("desktop-auth-03-wrong-verifier", {
    expectations: [
      "An exchange whose verifier does not hash to the approved challenge returns 403 FORBIDDEN (verifier_mismatch) and no session.",
      "The failed attempt is counted and the request stays redeemable by the real desktop.",
    ],
    details: { wrong: wrong.body, row, rightStatus: right.status },
  });
});

test("an expired request is refused", async ({ cloud }) => {
  const user = await cloud.user();
  const { verifier, challenge, state } = pkcePair();
  await approve(user, challenge, state);
  await cloud.admin
    .from("desktop_auth_requests")
    .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq("state", state);

  const result = await exchange(state, verifier);
  expect(result.status).toBe(404);
  expect(result.body.error).toMatchObject({ code: "NOT_FOUND", details: { reason: "expired" } });
  expect(result.body.session).toBeUndefined();

  recordOutcome("desktop-auth-04-expired", {
    expectations: [
      "An approved request past its 5-minute expiry returns 404 NOT_FOUND with reason expired and no session.",
    ],
    details: { status: result.status, body: result.body },
  });
});

test("approval needs a signed-in user and a valid, unused challenge", async ({ cloud }) => {
  const user = await cloud.user();
  const other = await cloud.user();
  const { challenge, state } = pkcePair();

  const anonymous = await approve(null, challenge, state);
  const badChallenge = await approve(user, "not-a-challenge", state);
  const first = await approve(user, challenge, state);
  const again = await approve(user, challenge, state);
  const hijack = await approve(other, pkcePair().challenge, state);

  expect(anonymous.status).toBe(401);
  expect(badChallenge.status).toBe(422);
  expect([first.status, again.status]).toEqual([200, 200]);
  expect(hijack.status).toBe(422);
  const { data: rows } = await cloud.admin
    .from("desktop_auth_requests")
    .select("user_id, code_challenge")
    .eq("state", state);
  expect(rows).toEqual([{ user_id: user.user.id, code_challenge: challenge }]);

  recordOutcome("desktop-auth-05-approve-rules", {
    expectations: [
      "desktop-auth-approve without a session returns 401; a malformed code challenge returns 422.",
      "Re-approving the same state and challenge by the same user is idempotent (200).",
      "Another user cannot rebind an approved state (422); the row keeps the first user and challenge.",
    ],
    details: {
      anonymous: anonymous.status,
      badChallenge: badChallenge.body,
      hijack: hijack.body,
      rows,
    },
  });
});
