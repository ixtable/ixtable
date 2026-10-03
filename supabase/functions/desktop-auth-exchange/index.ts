// Redeems an approved desktop sign-in hand-off for a session (no caller JWT:
// the PKCE verifier is the proof). The desktop polls with {state,
// codeVerifier}: 428 PENDING until the website approves, then exactly one
// successful exchange. The session is minted for the approving user without
// touching their password: an Auth admin magic-link token is generated and
// verified server-side (generateLink + verifyOtp with the token hash).
//
// POST {state, codeVerifier}
//   → {session:{access_token, refresh_token, expires_at, expires_in, token_type, user:{id, email}}}
// Errors: 428 PENDING (keep polling), 404 NOT_FOUND {reason: expired|consumed},
// 403 FORBIDDEN {reason: verifier_mismatch}, 429 RATE_LIMITED, 422 VALIDATION.
import { audit, ipHash } from "../_shared/audit.ts";
import {
  CODE_VERIFIER_RE,
  DESKTOP_AUTH_MAX_FAILURES,
  desktopAuthState,
  STATE_RE,
} from "../_shared/credentials.ts";
import { pkceChallenge, timingSafeEqual } from "../_shared/crypto.ts";
import { anonClient, serviceClient } from "../_shared/db.ts";
import { handler, HttpError, readJson } from "../_shared/http.ts";
import { enforceRateLimit, incrementMetric } from "../_shared/rateLimit.ts";
import { str } from "../_shared/validate.ts";

interface RequestRow {
  id: string;
  user_id: string | null;
  code_challenge: string;
  approved_at: string | null;
  expires_at: string;
  consumed_at: string | null;
  failed_attempts: number;
}

Deno.serve(
  handler(async (req) => {
    const body = await readJson(req);
    const state = str(body, "state", { min: 16, max: 200, pattern: STATE_RE });
    const codeVerifier = str(body, "codeVerifier", {
      min: 43,
      max: 128,
      pattern: CODE_VERIFIER_RE,
    });

    // Polling every second or two for five minutes stays well under this.
    await enforceRateLimit(`desktop-auth-exchange:ip:${(await ipHash(req)) ?? "unknown"}`, 120, 60);

    const db = serviceClient();
    const found = await db
      .from("desktop_auth_requests")
      .select("id, user_id, code_challenge, approved_at, expires_at, consumed_at, failed_attempts")
      .eq("state", state)
      .maybeSingle();
    if (found.error) throw new Error(`load desktop auth request failed: ${found.error.message}`);
    const row = found.data as RequestRow | null;

    const status = desktopAuthState(row);
    if (status === "pending" || !row?.user_id)
      throw new HttpError("PENDING", "Waiting for approval in the browser");
    if (status === "consumed")
      throw new HttpError("NOT_FOUND", "This sign-in request was already used", {
        reason: "consumed",
      });
    if (status === "expired")
      throw new HttpError("NOT_FOUND", "This sign-in request expired", { reason: "expired" });

    if (!timingSafeEqual(await pkceChallenge(codeVerifier), row.code_challenge)) {
      const failures = row.failed_attempts + 1;
      await db
        .from("desktop_auth_requests")
        .update({
          failed_attempts: failures,
          ...(failures >= DESKTOP_AUTH_MAX_FAILURES
            ? { consumed_at: new Date().toISOString() }
            : {}),
        })
        .eq("id", row.id);
      throw new HttpError("FORBIDDEN", "The code verifier does not match", {
        reason: "verifier_mismatch",
      });
    }

    // Single use: only one concurrent exchange can flip consumed_at.
    const now = new Date().toISOString();
    const consumed = await db
      .from("desktop_auth_requests")
      .update({ consumed_at: now })
      .eq("id", row.id)
      .is("consumed_at", null)
      .gt("expires_at", now)
      .select("id")
      .maybeSingle();
    if (consumed.error)
      throw new Error(`consume desktop auth request failed: ${consumed.error.message}`);
    if (!consumed.data)
      throw new HttpError("NOT_FOUND", "This sign-in request was already used", {
        reason: "consumed",
      });

    const account = await db.auth.admin.getUserById(row.user_id);
    const email = account.data.user?.email;
    if (account.error || !email)
      throw new HttpError("NOT_FOUND", "Account not found", { reason: "account_missing" });

    const link = await db.auth.admin.generateLink({ type: "magiclink", email });
    if (link.error || !link.data.properties?.hashed_token)
      throw new Error(`generateLink failed: ${link.error?.message ?? "no token"}`);
    const verified = await anonClient().auth.verifyOtp({
      token_hash: link.data.properties.hashed_token,
      type: "magiclink",
    });
    const session = verified.data.session;
    if (verified.error || !session)
      throw new Error(`verifyOtp failed: ${verified.error?.message ?? "no session"}`);

    await audit({
      action: "auth.desktop_exchange",
      actorId: row.user_id,
      target: `user:${row.user_id}`,
      details: { requestId: row.id },
      req,
    });
    await incrementMetric("auth.desktop_exchange");

    return {
      session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        expires_in: session.expires_in,
        token_type: session.token_type,
        user: { id: session.user.id, email: session.user.email },
      },
    };
  }),
);
