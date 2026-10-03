// Append-only audit trail (PRD §25). Edge Functions record every
// access-relevant action through `audit()`; clients cannot write audit rows.
import { serviceClient } from "./db.ts";
import { hmacSha256Hex } from "./crypto.ts";

export interface AuditInput {
  /** Dotted action name, e.g. "app.create", "key.issue", "member.revoke". */
  action: string;
  actorId?: string | null;
  orgId?: string | null;
  appId?: string | null;
  /** Free-form target id ("user:<uuid>", "version:<uuid>", ...). */
  target?: string | null;
  /** Structured context. Secret-looking keys are redacted before storage. */
  details?: Record<string, unknown>;
  /** The request, to store a keyed hash of the client IP (never the raw IP). */
  req?: Request;
}

const SECRET_KEY =
  /(secret|password|passwd|token|dek|private|ciphertext|nonce|authorization|cookie|signature|api_?key|refresh|access_?token)/i;

/** Deep copy with secret-looking keys replaced by "[redacted]". */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactSecrets(item);
  }
  return out;
}

/** HMAC of the first X-Forwarded-For hop with IXTABLE_FINGERPRINT_SECRET, or null. */
export async function ipHash(req: Request): Promise<string | null> {
  const secret = Deno.env.get("IXTABLE_FINGERPRINT_SECRET");
  const ip = (req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "")
    .split(",")[0]
    .trim();
  if (!secret || !ip) return null;
  return (await hmacSha256Hex(secret, `ip|${ip}`)).slice(0, 32);
}

/** Records an audit event via the `audit` SQL function. Returns the event id. */
export async function audit(input: AuditInput): Promise<string> {
  const { data, error } = await serviceClient().rpc("audit", {
    p_action: input.action,
    p_actor_id: input.actorId ?? null,
    p_org_id: input.orgId ?? null,
    p_app_id: input.appId ?? null,
    p_target: input.target ?? null,
    p_details: redactSecrets(input.details ?? {}),
    p_ip_hash: input.req ? await ipHash(input.req) : null,
  });
  if (error) throw new Error(`audit(${input.action}) failed: ${error.message}`);
  return data as string;
}
