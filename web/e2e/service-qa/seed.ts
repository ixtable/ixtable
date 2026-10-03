/**
 * Seed helpers for service-qa. Users are created through the public
 * email/password sign-up (the path the website uses), never OAuth. Rows the
 * contract under test does not create are seeded with the service role, so a
 * spec exercises exactly one contract. Prefer `CloudFixture` (fixture.ts),
 * which tracks everything for teardown.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getAnonClient, getServiceClient } from "./clients";

export interface TestUser {
  user: User;
  email: string;
  password: string;
  /** Anon-key client holding this user's session (RLS applies). */
  client: SupabaseClient;
  /** The user's access token, for Edge Function calls. */
  jwt: string;
}

export function uniqueEmail(prefix = "service-qa"): string {
  return `${prefix}-${randomBytes(6).toString("hex")}@example.com`;
}

export function randomPassword(): string {
  return `Pw-${randomBytes(12).toString("base64url")}!a1`;
}

/** Signs in with email/password on a fresh client. */
export async function signIn(email: string, password: string): Promise<TestUser> {
  const client = getAnonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user)
    throw new Error(`signInWithPassword failed: ${error?.message ?? "no session"}`);
  return { user: data.user, email, password, client, jwt: data.session.access_token };
}

/** Creates a user via public sign-up (confirmations are off locally) and signs in. */
export async function createTestUser(
  opts: { email?: string; password?: string } = {},
): Promise<TestUser> {
  const email = opts.email ?? uniqueEmail();
  const password = opts.password ?? randomPassword();
  const anon = getAnonClient();
  const { data, error } = await anon.auth.signUp({ email, password });
  if (error || !data.user) throw new Error(`signUp failed: ${error?.message ?? "no user"}`);
  return signIn(email, password);
}

export async function deleteTestUser(userId: string, admin = getServiceClient()): Promise<void> {
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error && !/not.?found/i.test(error.message))
    throw new Error(`deleteUser failed: ${error.message}`);
}

function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error || result.data === null)
    throw new Error(`${what} failed: ${result.error?.message ?? "no row"}`);
  return result.data;
}

export interface OrgRow {
  id: string;
  name: string;
  created_by: string;
}

/** Creates an organization as `owner` through RLS (owner membership is added by trigger). */
export async function createOrg(
  owner: TestUser,
  name = `QA org ${randomBytes(3).toString("hex")}`,
): Promise<OrgRow> {
  return must(
    await owner.client
      .from("organizations")
      .insert({ name, created_by: owner.user.id })
      .select()
      .single(),
    "createOrg",
  ) as OrgRow;
}

export interface AppRow {
  id: string;
  org_id: string;
  owner_id: string;
  name: string;
  document_id: string;
  datasource_kind: "sqlite" | "postgres";
  backups_enabled: boolean;
}

/** Inserts a cloud app with the service role (apps-create is tested in its own spec). */
export async function createApp(
  org: OrgRow,
  owner: TestUser,
  opts: { name?: string; datasourceKind?: "sqlite" | "postgres"; backupsEnabled?: boolean } = {},
): Promise<AppRow> {
  return must(
    await getServiceClient()
      .from("cloud_apps")
      .insert({
        org_id: org.id,
        owner_id: owner.user.id,
        name: opts.name ?? `QA app ${randomBytes(3).toString("hex")}`,
        document_id: randomUUID(),
        datasource_kind: opts.datasourceKind ?? "sqlite",
        backups_enabled: opts.backupsEnabled ?? false,
      })
      .select()
      .single(),
    "createApp",
  ) as AppRow;
}

export interface RoleRow {
  app_id: string;
  id: string;
  name: string;
  permissions: Record<string, unknown>;
}

export async function createRole(
  appId: string,
  opts: { id?: string; name?: string; permissions?: Record<string, unknown> } = {},
): Promise<RoleRow> {
  return must(
    await getServiceClient()
      .from("app_roles")
      .insert({
        app_id: appId,
        id: opts.id ?? randomUUID(),
        name: opts.name ?? "Runtime user",
        permissions: opts.permissions ?? {},
      })
      .select()
      .single(),
    "createRole",
  ) as RoleRow;
}

export async function addMember(
  appId: string,
  userId: string,
  roleId: string,
  status: "active" | "revoked" = "active",
): Promise<void> {
  const { error } = await getServiceClient()
    .from("app_members")
    .insert({ app_id: appId, user_id: userId, role_id: roleId, status });
  if (error) throw new Error(`addMember failed: ${error.message}`);
}

/** Gives the app a subscription so entitlement checks pass (fake provider). */
export async function grantSubscription(
  appId: string,
  planId: "starter" | "team" | "business" = "team",
  status = "active",
): Promise<void> {
  const { error } = await getServiceClient()
    .from("subscriptions")
    .upsert(
      {
        app_id: appId,
        plan_id: planId,
        provider: "fake",
        status,
        current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
      { onConflict: "app_id" },
    );
  if (error) throw new Error(`grantSubscription failed: ${error.message}`);
}

export interface VersionRow {
  id: string;
  app_id: string;
  version: string;
  status: string;
  archive_sha256: string;
}

/** Inserts an app_versions row (no archive bytes) with the service role. */
export async function createVersion(
  app: AppRow,
  developerId: string,
  opts: { version?: string; status?: "pending" | "published" | "withdrawn" } = {},
): Promise<VersionRow> {
  const id = randomUUID();
  return must(
    await getServiceClient()
      .from("app_versions")
      .insert({
        id,
        app_id: app.id,
        version: opts.version ?? "1.0.0",
        developer_id: developerId,
        archive_sha256: createHash("sha256").update(id).digest("hex"),
        archive_size: 1024,
        storage_path: `apps/${app.id}/versions/${id}.ixt`,
        status: opts.status ?? "published",
      })
      .select()
      .single(),
    "createVersion",
  ) as VersionRow;
}

/** Registers a Runtime installation for `userId`. */
export async function createInstallation(
  appId: string,
  userId: string,
  deviceName = "QA device",
): Promise<string> {
  const id = randomUUID();
  const { error } = await getServiceClient()
    .from("installations")
    .insert({ id, app_id: appId, user_id: userId, device_name: deviceName });
  if (error) throw new Error(`createInstallation failed: ${error.message}`);
  return id;
}

/** sha256 hex, e.g. for invitation token hashes. */
export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
