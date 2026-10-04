// Local Supabase stack access for the cloud integration tests. These tests run
// only against a local stack (never a hosted project) and skip with a message
// when it, or the Edge Functions they need, are not up.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const CLOUD_URL = (process.env.IXTABLE_CLOUD_URL ?? "http://127.0.0.1:54321").replace(
  /\/$/,
  "",
);
const ANON_KEY =
  process.env.IXTABLE_CLOUD_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** Functions the end-to-end flow calls. */
const REQUIRED = [
  "apps-create",
  "roles-sync",
  "archive-upload-url",
  "publish-checkpoint",
  "invitations-create",
  "invitations-accept",
  "bundle-manifest",
  "sync-check",
  "key-grant",
  "members-update",
];

function localKey(): string | undefined {
  if (process.env.IXTABLE_CLOUD_PUBLIC_KEY_RAW) return process.env.IXTABLE_CLOUD_PUBLIC_KEY_RAW;
  try {
    const env = readFileSync(join(process.cwd(), "supabase", "functions", ".env.local"), "utf8");
    return /^IXTABLE_CLOUD_PUBLIC_KEY_RAW=(.+)$/m.exec(env)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Why the cloud tests cannot run here, or "" when they can. On success the
 * process environment points the Rust bridge at the local stack.
 */
export async function cloudUnavailable(required = REQUIRED): Promise<string> {
  const { hostname } = new URL(CLOUD_URL);
  if (!["127.0.0.1", "localhost"].includes(hostname))
    return `refusing non-local IXTABLE_CLOUD_URL ${CLOUD_URL}`;
  try {
    const health = await fetch(`${CLOUD_URL}/functions/v1/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!health.ok) return `health answered ${health.status}`;
  } catch {
    return `the local stack at ${CLOUD_URL} is not reachable (npm run service-qa:up)`;
  }
  const missing: string[] = [];
  for (const name of required) {
    const reply = await fetch(`${CLOUD_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "content-type": "application/json" },
      body: "{}",
    }).catch(() => null);
    const body = reply ? await reply.json().catch(() => null) : null;
    if (!body?.error?.code || body.error.message?.includes("not implemented")) missing.push(name);
  }
  if (missing.length) return `Edge Functions not deployed yet: ${missing.join(", ")}`;
  const key = localKey();
  if (!key) return "no IXTABLE_CLOUD_PUBLIC_KEY_RAW (run scripts/cloud/dev-secrets.mjs)";
  process.env.IXTABLE_CLOUD_URL = CLOUD_URL;
  process.env.IXTABLE_CLOUD_ANON_KEY = ANON_KEY;
  process.env.IXTABLE_CLOUD_PUBLIC_KEY_RAW = key;
  process.env.IXTABLE_CLOUD_NO_BROWSER = "1";
  return "";
}

const options = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
};
export const serviceClient = () => createClient(CLOUD_URL, SERVICE_KEY, options);

/** A separate signed-in client (another person, outside the app under test). */
export async function userClient(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(CLOUD_URL, ANON_KEY, options);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

export async function createConfirmedUser(email: string, password: string) {
  const { data, error } = await serviceClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  return data.user;
}

export const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

/** Entitlement for the app (fake billing provider). */
export async function grantSubscription(appId: string) {
  const { error } = await serviceClient()
    .from("subscriptions")
    .upsert(
      {
        app_id: appId,
        plan_id: "team",
        provider: "fake",
        status: "active",
        current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
      { onConflict: "app_id" },
    );
  if (error) throw error;
}

export async function invoke<T>(client: SupabaseClient, name: string, body: object): Promise<T> {
  const { data, error } = await client.functions.invoke(name, { body });
  if (error) {
    const context = (error as { context?: Response }).context;
    const detail = context ? await context.json().catch(() => null) : null;
    throw Object.assign(new Error(detail?.error?.message ?? error.message), {
      code: detail?.error?.code,
    });
  }
  return data as T;
}
