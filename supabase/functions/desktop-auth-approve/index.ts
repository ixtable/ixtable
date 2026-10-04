// Approves a desktop sign-in hand-off (PKCE S256). The desktop opens
// <site>/desktop-auth?code_challenge=…&state=…; the signed-in website calls
// this function, which binds the request to the caller for five minutes. The
// desktop then redeems it once with desktop-auth-exchange and the verifier.
// Approving the same state again with the same challenge is idempotent; any
// other reuse of a state is refused.
//
// POST {codeChallenge, state} → {ok:true, expiresAt}
import { audit } from "../_shared/audit.ts";
import { CODE_CHALLENGE_RE, DESKTOP_AUTH_TTL_MS, STATE_RE } from "../_shared/credentials.ts";
import { timingSafeEqual } from "../_shared/crypto.ts";
import { serviceClient } from "../_shared/db.ts";
import { handler, HttpError, readJson, requireUser } from "../_shared/http.ts";
import { enforceNamedRateLimit } from "../_shared/rateLimit.ts";
import { str } from "../_shared/validate.ts";

Deno.serve(
  handler(async (req) => {
    const { user } = await requireUser(req);
    const body = await readJson(req);
    const codeChallenge = str(body, "codeChallenge", {
      min: 43,
      max: 43,
      pattern: CODE_CHALLENGE_RE,
    });
    const state = str(body, "state", { min: 16, max: 200, pattern: STATE_RE });
    if (!user.email) throw new HttpError("VALIDATION", "This account has no email address");

    await enforceNamedRateLimit("desktop-auth-approve", user.id);
    const db = serviceClient();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DESKTOP_AUTH_TTL_MS).toISOString();

    const inserted = await db
      .from("desktop_auth_requests")
      .insert({
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        user_id: user.id,
        approved_at: now.toISOString(),
        expires_at: expiresAt,
      })
      .select("id, expires_at")
      .single();

    if (inserted.error) {
      // 23505: the state was approved before.
      if (inserted.error.code !== "23505")
        throw new Error(`insert desktop auth request failed: ${inserted.error.message}`);
      const existing = await db
        .from("desktop_auth_requests")
        .select("id, user_id, code_challenge, expires_at, consumed_at")
        .eq("state", state)
        .single();
      if (existing.error)
        throw new Error(`load desktop auth request failed: ${existing.error.message}`);
      const row = existing.data;
      const same =
        row.user_id === user.id &&
        timingSafeEqual(row.code_challenge, codeChallenge) &&
        !row.consumed_at &&
        new Date(row.expires_at).getTime() > now.getTime();
      if (!same)
        throw new HttpError(
          "VALIDATION",
          "This sign-in request was already used. Start again from the app.",
        );
      return { ok: true, expiresAt: row.expires_at };
    }

    await audit({
      action: "auth.desktop_approve",
      actorId: user.id,
      target: `user:${user.id}`,
      details: { requestId: inserted.data.id },
      req,
    });
    return { ok: true, expiresAt: inserted.data.expires_at };
  }),
);
