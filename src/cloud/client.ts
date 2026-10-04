import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import {
  authStorageGet,
  authStorageRemove,
  authStorageSet,
  cloudConfig,
  signOutLocal,
} from "./api";
import { backupRow, type DesktopFunction, type DesktopReplies, decoders } from "./contract";
import { CloudError, toCloudError } from "./errors";
import type { AppVersion, CloudApp, InstallationBackup, MemberApp, Organization } from "./types";

/**
 * supabase-js session storage backed by the local secret store (Rust): the
 * refresh token is sealed with the machine key, never in localStorage,
 * archives, or logs.
 */
export const secureStorage = {
  getItem: (key: string) => authStorageGet(key).catch(() => null),
  setItem: (key: string, value: string) => authStorageSet(key, value),
  removeItem: (key: string) => authStorageRemove(key),
};

let cached: { key: string; client: SupabaseClient } | null = null;

/** The supabase-js client for the configured cloud (one per URL + anon key). */
export async function cloudClient(): Promise<SupabaseClient> {
  const config = await cloudConfig();
  if (!config.configured)
    throw new CloudError("CLOUD_NOT_CONFIGURED", "ixtable Cloud is not configured in this build.");
  const key = `${config.url}|${config.anonKey}`;
  if (cached?.key === key) return cached.client;
  const client = createClient(config.url, config.anonKey, {
    auth: {
      storage: secureStorage,
      storageKey: "sb-ixtable-auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  cached = { key, client };
  client.auth.onAuthStateChange((_event, session) => publish(session));
  return client;
}

// Session store for React (useSyncExternalStore in auth.tsx).
type Listener = () => void;
const listeners = new Set<Listener>();
let current: { session: Session | null; ready: boolean } = { session: null, ready: false };
function publish(session: Session | null) {
  if (current.session === session && current.ready) return;
  current = { session, ready: true };
  for (const listener of listeners) listener();
}
export const sessionSnapshot = () => current;
export function subscribeSession(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Loads the stored session (refreshing it when needed). */
export async function loadSession(): Promise<Session | null> {
  try {
    const client = await cloudClient();
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    publish(data.session);
    return data.session;
  } catch {
    publish(null);
    return null;
  }
}

export async function requireSession(): Promise<Session> {
  const session = (await loadSession()) ?? null;
  if (!session) throw new CloudError("UNAUTHENTICATED", "Sign in to ixtable Cloud first.");
  return session;
}

export async function signInWithPassword(email: string, password: string) {
  const client = await cloudClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw await toCloudError(error);
  publish(data.session);
  return data.session;
}

export async function signUp(email: string, password: string) {
  const client = await cloudClient();
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw await toCloudError(error);
  if (data.session) publish(data.session);
  return data.session;
}

/**
 * Sends the password-recovery email, the same Supabase flow the website's
 * "Forgot password" page uses; its link opens the website's reset page.
 */
export async function requestPasswordReset(email: string) {
  const client = await cloudClient();
  const { siteUrl } = await cloudConfig();
  const redirectTo = siteUrl ? `${siteUrl.replace(/\/$/, "")}/reset-password` : undefined;
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw await toCloudError(error);
}

/** Adopts a session handed over by the browser sign-in (PKCE exchange). */
export async function adoptSession(tokens: { access_token: string; refresh_token: string }) {
  const client = await cloudClient();
  const { data, error } = await client.auth.setSession(tokens);
  if (error) throw await toCloudError(error);
  publish(data.session);
  return data.session;
}

/** Signs out: revokes the refresh token, clears stored session and in-memory credentials. */
export async function signOut() {
  await signOutLocal().catch(() => undefined);
  try {
    const client = await cloudClient();
    await client.auth.signOut({ scope: "local" });
  } finally {
    publish(null);
  }
}

/**
 * Calls an Edge Function with the user's JWT and decodes the reply
 * (contract.ts); errors become CloudErrors.
 */
export async function invokeFunction<K extends DesktopFunction>(
  name: K,
  body: Record<string, unknown>,
): Promise<DesktopReplies[K]> {
  const client = await cloudClient();
  await requireSession();
  const { data, error } = await client.functions.invoke(name, { body });
  if (error) throw await toCloudError(error);
  return decoders[name](data);
}

async function rows<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw await toCloudError(error);
  return data as T;
}

/** A to-one embed arrives as an object (or a one-element array without schema types). */
const one = <X>(value: X | X[] | null | undefined): X | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

type Named = { id: string; name: string };
type OrgRow = { role: Organization["role"]; organizations: Named | Named[] | null };
export async function listOrganizations(): Promise<Organization[]> {
  const session = await requireSession();
  const client = await cloudClient();
  const data = await rows<OrgRow[]>(
    client
      .from("org_members")
      .select("role, organizations(id, name)")
      .eq("user_id", session.user.id),
  );
  return data.flatMap((row) => {
    const org = one(row.organizations);
    return org ? [{ id: org.id, name: org.name, role: row.role }] : [];
  });
}

export async function createOrganization(name: string): Promise<Organization> {
  const session = await requireSession();
  const client = await cloudClient();
  const org = await rows<{ id: string; name: string }>(
    client
      .from("organizations")
      .insert({ name, created_by: session.user.id })
      .select("id, name")
      .single(),
  );
  return { ...org, role: "owner" };
}

type AppRow = {
  id: string;
  org_id: string;
  owner_id: string;
  name: string;
  document_id: string;
  backups_enabled: boolean;
  head_version_id: string | null;
};
const toApp = (row: AppRow): CloudApp => ({
  id: row.id,
  orgId: row.org_id,
  ownerId: row.owner_id,
  name: row.name,
  documentId: row.document_id,
  backupsEnabled: row.backups_enabled,
  headVersionId: row.head_version_id,
});

export async function getApp(appId: string): Promise<CloudApp | null> {
  const client = await cloudClient();
  const row = await rows<AppRow | null>(
    client
      .from("cloud_apps")
      .select("id, org_id, owner_id, name, document_id, backups_enabled, head_version_id")
      .eq("id", appId)
      .maybeSingle(),
  );
  return row ? toApp(row) : null;
}

export async function listVersions(appId: string): Promise<AppVersion[]> {
  const client = await cloudClient();
  type Row = {
    id: string;
    version: string;
    created_at: string;
    archive_sha256: string;
    archive_size: number;
    release_notes: string;
    status: AppVersion["status"];
    min_runtime_version: string;
    resolution: string | null;
  };
  const data = await rows<Row[]>(
    client
      .from("app_versions")
      .select(
        "id, version, created_at, archive_sha256, archive_size, release_notes, status, min_runtime_version, resolution",
      )
      .eq("app_id", appId)
      .order("created_at", { ascending: false }),
  );
  return data.map((row) => ({
    id: row.id,
    version: row.version,
    createdAt: row.created_at,
    archiveSha256: row.archive_sha256,
    archiveSize: row.archive_size,
    releaseNotes: row.release_notes,
    status: row.status,
    minRuntimeVersion: row.min_runtime_version,
    resolution: row.resolution,
  }));
}

/** This installation's backups, newest first (RLS: the installing user or app admins). */
export async function listInstallationBackups(
  appId: string,
  installationId: string,
): Promise<InstallationBackup[]> {
  const client = await cloudClient();
  const data = await rows<unknown[]>(
    client
      .from("installation_backups")
      .select("id, installation_id, archive_sha256, archive_size, created_at")
      .eq("app_id", appId)
      .eq("installation_id", installationId)
      .order("created_at", { ascending: false }),
  );
  return data.map(backupRow);
}

/** Release notes of a published version ("" when the row is not readable). */
export async function versionReleaseNotes(versionId: string): Promise<string> {
  const client = await cloudClient();
  const row = await rows<{ release_notes: string | null } | null>(
    client.from("app_versions").select("release_notes").eq("id", versionId).maybeSingle(),
  );
  return row?.release_notes ?? "";
}

/** Active runtime users of an app (for the PRD §19 concurrency check). */
export async function countRuntimeUsers(appId: string): Promise<number> {
  const client = await cloudClient();
  const { count, error } = await client
    .from("app_members")
    .select("user_id", { count: "exact", head: true })
    .eq("app_id", appId)
    .eq("status", "active");
  if (error) throw await toCloudError(error);
  return count ?? 0;
}

/**
 * How many runtime users can use the app: active members, or the plan's
 * allowance when larger (the server applies the same rule at publish).
 */
export async function runtimeCapacity(appId: string): Promise<number> {
  const members = await countRuntimeUsers(appId).catch(() => 0);
  const client = await cloudClient();
  type Row = {
    status: string;
    plans: { runtime_user_allowance: number } | { runtime_user_allowance: number }[] | null;
  };
  const { data } = await client
    .from("subscriptions")
    .select("status, plans(runtime_user_allowance)")
    .eq("app_id", appId)
    .maybeSingle();
  const allowance = one((data as Row | null)?.plans)?.runtime_user_allowance ?? 0;
  return Math.max(members, allowance);
}

/** Apps the signed-in user is an active runtime member of. */
export async function listMemberApps(): Promise<MemberApp[]> {
  const session = await requireSession();
  const client = await cloudClient();
  type Row = {
    app_id: string;
    role_id: string;
    status: MemberApp["status"];
    cloud_apps: Named | Named[] | null;
  };
  const members = await rows<Row[]>(
    client
      .from("app_members")
      .select("app_id, role_id, status, cloud_apps(id, name)")
      .eq("user_id", session.user.id)
      .eq("status", "active"),
  );
  const roleRows = await rows<{ app_id: string; id: string; name: string }[]>(
    client.from("app_roles").select("app_id, id, name"),
  ).catch(() => []);
  return members.flatMap((row) => {
    const app = one(row.cloud_apps);
    if (!app) return [];
    const role = roleRows.find((r) => r.app_id === row.app_id && r.id === row.role_id);
    return [
      {
        appId: row.app_id,
        name: app.name,
        roleId: row.role_id,
        roleName: role?.name ?? "",
        status: row.status,
      },
    ];
  });
}
