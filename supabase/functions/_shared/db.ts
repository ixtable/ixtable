// Supabase clients and environment access for Edge Functions. The service
// client bypasses RLS: use it only after the caller is authorized.
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

export type { SupabaseClient, User };

/** Reads a required env var. Throws (→ INTERNAL) when missing. */
export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value ? value : undefined;
}

const clientOptions = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
};

let service: SupabaseClient | null = null;

/** Service-role client (singleton). Bypasses RLS. */
export function serviceClient(): SupabaseClient {
  if (!service) {
    service = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), clientOptions);
  }
  return service;
}

/** Client that acts as the caller: PostgREST applies RLS with their JWT. */
export function userClient(jwt: string): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    ...clientOptions,
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/** Anon client, e.g. for Auth flows that must not use the service role. */
export function anonClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), clientOptions);
}

/** Storage bucket for every `.ixt` archive. */
export const ARCHIVE_BUCKET = "app-archives";
/** PRD §7.4: 500 MB per archive. */
export const MAX_ARCHIVE_BYTES = 524_288_000;
