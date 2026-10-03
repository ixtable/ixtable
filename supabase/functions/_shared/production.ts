// Production-only guards (docs/ops/production-config.md). IXTABLE_ENV=production
// marks a hosted production project; local and QA stacks leave it unset.
import { HttpError } from "./http.ts";

type Env = Record<string, string | undefined>;

export function isProduction(env: Env = Deno.env.toObject()): boolean {
  return env.IXTABLE_ENV === "production";
}

/** True unless Auth settings say email confirmations are on (unknown counts as off). */
export function confirmationsOff(settings: unknown): boolean {
  return (settings as { mailer_autoconfirm?: unknown } | null)?.mailer_autoconfirm !== false;
}

let confirmed = false;

/**
 * Invitations bind to the invitee's email address, which is proof of
 * ownership only when Auth confirms addresses (`enable_confirmations`). In
 * production, refuse (500 INTERNAL, details.reason
 * "email_confirmations_disabled") while the Auth settings report
 * `mailer_autoconfirm`, or cannot be read.
 */
export async function requireEmailConfirmations(
  env: Env = Deno.env.toObject(),
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!isProduction(env) || confirmed) return;
  const settings: unknown = await fetcher(`${env.SUPABASE_URL}/auth/v1/settings`, {
    headers: { apikey: env.SUPABASE_ANON_KEY ?? "" },
  })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (confirmationsOff(settings))
    throw new HttpError(
      "INTERNAL",
      "Invitations are disabled until email confirmations are turned on for this project",
      { reason: "email_confirmations_disabled" },
    );
  confirmed = true;
}
