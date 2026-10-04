/**
 * Contract: ixtable Cloud data is private by default (PRD §21.1, §27.2).
 * Anonymous callers and unrelated users read nothing; Runtime Users read only
 * their own membership and app basics; audit is append-only; published
 * checkpoints are immutable; archive objects are reachable only through
 * signed URLs minted with the service role.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAnonClient, getServiceClient } from "../clients";
import { type CloudFixture, expect, test } from "../fixture";
import { recordOutcome } from "../record";
import {
  addMember,
  createInstallation,
  createRole,
  createVersion,
  grantSubscription,
  sha256Hex,
} from "../seed";

const PRIVATE_TABLES = [
  "profiles",
  "organizations",
  "org_members",
  "cloud_apps",
  "app_roles",
  "app_members",
  "invitations",
  "app_versions",
  "archive_uploads",
  "installations",
  "installation_backups",
  "credential_envelopes",
  "key_grants",
  "plans",
  "subscriptions",
  "billing_events",
  "audit_events",
  "rate_limits",
  "service_metrics",
  "desktop_auth_requests",
] as const;

// Columns a client may select on tables with column-level grants.
const SELECT_COLUMNS: Record<string, string> = {
  invitations: "id,kind,app_id,email",
  credential_envelopes: "id,app_id,datasource_id,scope",
};

type Visibility = number | "denied";

async function visibleRows(client: SupabaseClient, table: string): Promise<Visibility> {
  const { data, error } = await client.from(table).select(SELECT_COLUMNS[table] ?? "*");
  if (error) return "denied";
  return (data ?? []).length;
}

async function visibility(
  client: SupabaseClient,
  tables: readonly string[],
): Promise<Record<string, Visibility>> {
  const out: Record<string, Visibility> = {};
  for (const table of tables) out[table] = await visibleRows(client, table);
  return out;
}

/** Owner, org, app, a Runtime User, an unrelated user, and one row in every private table. */
async function seedWorld(cloud: CloudFixture) {
  const admin = getServiceClient();
  const owner = await cloud.user();
  const runtime = await cloud.user();
  const stranger = await cloud.user();
  const org = await cloud.org(owner);
  const app = await cloud.app(org, owner);
  const role = await createRole(app.id, { name: "Clerk" });
  await addMember(app.id, runtime.user.id, role.id);
  await grantSubscription(app.id, "starter");
  const published = await createVersion(app, owner.user.id, {
    version: "1.0.0",
    status: "published",
  });
  const pending = await createVersion(app, owner.user.id, { version: "1.1.0", status: "pending" });
  const installationId = await createInstallation(app.id, runtime.user.id);

  const insert = async (table: string, row: Record<string, unknown>) => {
    const { data, error } = await admin.from(table).insert(row).select("id").single();
    if (error) throw new Error(`seed ${table}: ${error.message}`);
    return (data as { id: string }).id;
  };
  const envelopeId = await insert("credential_envelopes", {
    app_id: app.id,
    datasource_id: "main",
    scope: "shared",
    ciphertext: "Y2lwaGVy",
    nonce: "bm9uY2U=",
    aad: "",
    wrapped_dek: "d3JhcHBlZA==",
    kek_version: 1,
    created_by: owner.user.id,
  });
  await insert("key_grants", {
    app_id: app.id,
    envelope_id: envelopeId,
    user_id: runtime.user.id,
    installation_id: installationId,
    datasource_id: "main",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const uploadId = await insert("archive_uploads", {
    app_id: app.id,
    user_id: runtime.user.id,
    kind: "backup",
    installation_id: installationId,
    storage_path: `apps/${app.id}/installations/${runtime.user.id}/${installationId}/${randomUUID()}.ixt`,
    expected_size: 10,
    expected_sha256: sha256Hex("backup"),
  });
  await insert("installation_backups", {
    app_id: app.id,
    user_id: runtime.user.id,
    installation_id: installationId,
    upload_id: uploadId,
    storage_path: `apps/${app.id}/installations/${runtime.user.id}/${installationId}/${randomUUID()}.ixt`,
    archive_sha256: sha256Hex("backup"),
    archive_size: 10,
  });
  await insert("invitations", {
    kind: "app",
    app_id: app.id,
    email: `invitee-${randomUUID().slice(0, 8)}@example.com`,
    role_id: role.id,
    token_hash: sha256Hex(randomUUID()),
    invited_by: owner.user.id,
  });
  await insert("billing_events", {
    event_id: `evt_${randomUUID()}`,
    type: "test.event",
    app_id: app.id,
  });
  await insert("desktop_auth_requests", {
    state: randomUUID(),
    code_challenge: "a".repeat(43),
  });
  const { error: auditError } = await admin.rpc("audit", {
    p_action: "app.create",
    p_actor_id: owner.user.id,
    p_app_id: app.id,
    p_target: `app:${app.id}`,
    p_details: { name: app.name },
  });
  if (auditError) throw new Error(`seed audit: ${auditError.message}`);
  await admin.rpc("rate_limit", { p_bucket: `qa:${randomUUID()}`, p_max: 5, p_window_seconds: 60 });
  await admin.rpc("metric_increment", { p_name: "qa.seed" });
  return {
    owner,
    runtime,
    stranger,
    org,
    app,
    role,
    published,
    pending,
    installationId,
    envelopeId,
  };
}

test("anonymous callers cannot read any cloud table", async ({ cloud }) => {
  await seedWorld(cloud);
  const seen = await visibility(getAnonClient(), PRIVATE_TABLES);
  for (const table of PRIVATE_TABLES) expect(seen[table], table).toBe("denied");

  recordOutcome("rls-private-01-anon-denied", {
    expectations: [
      "With only the anon key, every ixtable Cloud table (orgs, apps, versions, envelopes, grants, audit, billing, ...) returns permission denied.",
      "Rows exist in each table during the check, so the denial is not an empty table.",
    ],
    details: { visibility: seen },
  });
});

test("an unrelated signed-in user sees nothing but their own profile and the plan catalog", async ({
  cloud,
}) => {
  const world = await seedWorld(cloud);
  const seen = await visibility(world.stranger.client, PRIVATE_TABLES);
  const ownerSeen = await visibility(world.owner.client, PRIVATE_TABLES);

  const visibleToStranger: Record<string, Visibility> = { profiles: 1, plans: 3 };
  for (const table of PRIVATE_TABLES) {
    const expected = visibleToStranger[table];
    if (expected !== undefined) expect(seen[table], table).toBe(expected);
    else
      expect(seen[table] === 0 || seen[table] === "denied", `${table}: ${seen[table]}`).toBe(true);
  }
  // Positive control: the owner does see the same rows.
  for (const table of [
    "organizations",
    "cloud_apps",
    "app_versions",
    "app_members",
    "credential_envelopes",
    "key_grants",
    "subscriptions",
    "audit_events",
    "invitations",
  ]) {
    expect(ownerSeen[table], `owner ${table}`).not.toBe("denied");
    expect(ownerSeen[table] as number, `owner ${table}`).toBeGreaterThan(0);
  }
  const { data: byId } = await world.stranger.client
    .from("cloud_apps")
    .select("id")
    .eq("id", world.app.id);
  expect(byId).toEqual([]);

  recordOutcome("rls-private-02-unrelated-user", {
    expectations: [
      "A signed-in user with no membership reads zero rows (or is denied) in every cloud table except their own profile and the 3 active plans.",
      "Selecting the app by its exact id returns nothing to that user.",
      "The app owner reads the same org, app, versions, members, envelope metadata, grants, subscription, audit and invitation rows (positive control).",
    ],
    details: { stranger: seen, owner: ownerSeen },
  });
});

test("a Runtime User reads only app basics, their role and membership, and published versions", async ({
  cloud,
}) => {
  const world = await seedWorld(cloud);
  const client = world.runtime.client;
  const seen = await visibility(client, PRIVATE_TABLES);

  const { data: versions } = await client.from("app_versions").select("id,status");
  expect(versions).toEqual([{ id: world.published.id, status: "published" }]);
  const { data: members } = await client.from("app_members").select("user_id");
  expect(members).toEqual([{ user_id: world.runtime.user.id }]);
  const { data: profiles } = await client.from("profiles").select("id");
  expect(profiles).toEqual([{ id: world.runtime.user.id }]);
  expect(seen.cloud_apps).toBe(1);
  expect(seen.app_roles).toBe(1);
  expect(seen.installations).toBe(1);
  for (const table of [
    "credential_envelopes",
    "key_grants",
    "subscriptions",
    "audit_events",
    "invitations",
    "billing_events",
    "organizations",
    "org_members",
    "desktop_auth_requests",
  ]) {
    expect(seen[table] === 0 || seen[table] === "denied", `${table}: ${seen[table]}`).toBe(true);
  }
  const { data: secretColumns, error: secretError } = await world.owner.client
    .from("credential_envelopes")
    .select("ciphertext,wrapped_dek");
  expect(secretError?.code).toBe("42501");
  expect(secretColumns).toBeNull();

  recordOutcome("rls-private-03-runtime-user", {
    expectations: [
      "A Runtime User sees the app, their own role, membership and installation, and only the published version (not the pending one).",
      "The same user reads no envelopes, key grants, subscription, audit events, invitations, org rows or other users' profiles.",
      "Even the app owner cannot select envelope ciphertext or the wrapped DEK (column privilege denied, 42501).",
    ],
    details: { visibility: seen, versions, members },
  });
});

test("clients cannot write cloud tables or call privileged functions", async ({ cloud }) => {
  const world = await seedWorld(cloud);
  const owner = world.owner.client;
  const attempts: Record<string, string | null> = {};
  const record = (name: string, error: { code?: string; message: string } | null) => {
    attempts[name] = error ? (error.code ?? error.message) : null;
  };

  record(
    "insert cloud_apps",
    (
      await owner.from("cloud_apps").insert({
        org_id: world.org.id,
        owner_id: world.owner.user.id,
        name: "x",
        document_id: "d",
      })
    ).error,
  );
  record(
    "insert app_versions",
    (
      await owner.from("app_versions").insert({
        app_id: world.app.id,
        version: "9.9.9",
        developer_id: world.owner.user.id,
        archive_sha256: "a".repeat(64),
        archive_size: 1,
        storage_path: "x",
      })
    ).error,
  );
  record(
    "insert app_members",
    (
      await owner
        .from("app_members")
        .insert({ app_id: world.app.id, user_id: world.stranger.user.id, role_id: world.role.id })
    ).error,
  );
  record(
    "insert audit_events",
    (await owner.from("audit_events").insert({ action: "app.create" })).error,
  );
  record(
    "insert subscriptions",
    (
      await owner
        .from("subscriptions")
        .insert({ app_id: world.app.id, plan_id: "business", status: "active" })
    ).error,
  );
  record(
    "update cloud_apps.owner_id",
    (
      await owner
        .from("cloud_apps")
        .update({ owner_id: world.stranger.user.id })
        .eq("id", world.app.id)
    ).error,
  );
  record(
    "update profiles.is_operator",
    (await owner.from("profiles").update({ is_operator: true }).eq("id", world.owner.user.id))
      .error,
  );
  record(
    "rpc audit",
    (await owner.rpc("audit", { p_action: "app.delete", p_app_id: world.app.id })).error,
  );
  record(
    "rpc rate_limit",
    (await owner.rpc("rate_limit", { p_bucket: "x", p_max: 1, p_window_seconds: 1 })).error,
  );
  record(
    "anon rpc app_entitlement",
    (await getAnonClient().rpc("app_entitlement", { p_app_id: world.app.id })).error,
  );

  for (const [name, code] of Object.entries(attempts)) expect(code, name).not.toBeNull();

  const { data: ownerEntitlement } = await owner.rpc("app_entitlement", { p_app_id: world.app.id });
  const { data: strangerEntitlement } = await world.stranger.client.rpc("app_entitlement", {
    p_app_id: world.app.id,
  });
  expect(ownerEntitlement).toMatchObject({
    allowed: true,
    reason: "ok",
    allowance: 5,
    used: 1,
    planId: "starter",
  });
  expect(strangerEntitlement).toMatchObject({ allowed: false, reason: "not_found" });

  const { data: app } = await getServiceClient()
    .from("cloud_apps")
    .select("owner_id")
    .eq("id", world.app.id)
    .single();
  expect(app?.owner_id).toBe(world.owner.user.id);

  recordOutcome("rls-private-04-no-client-writes", {
    expectations: [
      "The app owner cannot insert apps, versions, members, audit events or subscriptions, change owner_id or set is_operator via PostgREST.",
      "Signed-in users cannot call audit() or rate_limit(); anon cannot call app_entitlement().",
      "app_entitlement returns {allowed:true, reason:'ok', allowance:5, used:1} to the owner and reason 'not_found' to an unrelated user.",
    ],
    details: { attempts, ownerEntitlement, strangerEntitlement },
  });
});

test("audit events are append-only, even for the service role", async ({ cloud }) => {
  const world = await seedWorld(cloud);
  const admin = getServiceClient();
  const { data: rows } = await admin
    .from("audit_events")
    .select("id,action")
    .eq("app_id", world.app.id);
  expect(rows?.length).toBe(1);
  const id = rows?.[0]?.id as string;

  const update = await admin.from("audit_events").update({ action: "app.delete" }).eq("id", id);
  const remove = await admin.from("audit_events").delete().eq("id", id);
  expect(update.error?.message).toContain("append-only");
  expect(remove.error?.message).toContain("append-only");
  const { data: after } = await admin
    .from("audit_events")
    .select("id,action")
    .eq("id", id)
    .single();
  expect(after).toEqual({ id, action: "app.create" });

  const { data: ownerView } = await world.owner.client
    .from("audit_events")
    .select("id")
    .eq("id", id);
  expect(ownerView).toEqual([{ id }]);

  recordOutcome("rls-private-05-audit-append-only", {
    expectations: [
      "UPDATE and DELETE on audit_events fail with 'append-only' even with the service role.",
      "The audit row is unchanged afterwards and the app owner can read it.",
    ],
    details: { id, update: update.error?.message, delete: remove.error?.message },
  });
});

test("published checkpoints are immutable; only the status moves forward", async ({ cloud }) => {
  const world = await seedWorld(cloud);
  const admin = getServiceClient();

  const tamper = await admin
    .from("app_versions")
    .update({ archive_sha256: "b".repeat(64) })
    .eq("id", world.published.id);
  const rewind = await admin
    .from("app_versions")
    .update({ status: "pending" })
    .eq("id", world.published.id);
  const publish = await admin
    .from("app_versions")
    .update({ status: "published" })
    .eq("id", world.pending.id)
    .select("status,published_at")
    .single();
  const withdraw = await admin
    .from("app_versions")
    .update({ status: "withdrawn" })
    .eq("id", world.published.id)
    .select("status,withdrawn_at")
    .single();
  const ownerUpdate = await world.owner.client
    .from("app_versions")
    .update({ release_notes: "x" })
    .eq("id", world.pending.id);

  expect(tamper.error?.message).toContain("immutable");
  expect(rewind.error?.message).toContain("invalid app_versions status transition");
  expect(publish.error).toBeNull();
  expect(publish.data?.status).toBe("published");
  expect(publish.data?.published_at).toBeTruthy();
  expect(withdraw.error).toBeNull();
  expect(withdraw.data?.withdrawn_at).toBeTruthy();
  expect(ownerUpdate.error?.code).toBe("42501");

  const { data: row } = await admin
    .from("app_versions")
    .select("archive_sha256")
    .eq("id", world.published.id)
    .single();
  expect(row?.archive_sha256).toBe(world.published.archive_sha256);

  recordOutcome("rls-private-06-versions-immutable", {
    expectations: [
      "Changing a version's archive_sha256 fails ('immutable') and moving published back to pending fails, even with the service role.",
      "pending→published sets published_at and published→withdrawn sets withdrawn_at.",
      "The app owner cannot update app_versions through PostgREST (42501).",
    ],
    details: {
      tamper: tamper.error?.message,
      rewind: rewind.error?.message,
      publish: publish.data,
      withdraw: withdraw.data,
    },
  });
});

test("archive objects are reachable only through service-minted signed URLs", async ({ cloud }) => {
  const world = await seedWorld(cloud);
  const admin = getServiceClient();
  const bucket = "app-archives";
  const path = `apps/${world.app.id}/versions/${randomUUID()}.ixt`;
  const bytes = new TextEncoder().encode("ixt-archive-bytes");

  const direct = await world.owner.client.storage
    .from(bucket)
    .upload(path, bytes, { contentType: "application/octet-stream" });
  expect(direct.error).not.toBeNull();

  const { data: signedUpload, error: signError } = await admin.storage
    .from(bucket)
    .createSignedUploadUrl(path);
  expect(signError).toBeNull();
  const uploaded = await world.owner.client.storage
    .from(bucket)
    .uploadToSignedUrl(path, signedUpload?.token as string, bytes, {
      contentType: "application/octet-stream",
    });
  expect(uploaded.error).toBeNull();

  const ownerDownload = await world.owner.client.storage.from(bucket).download(path);
  const anonDownload = await getAnonClient().storage.from(bucket).download(path);
  const ownerList = await world.owner.client.storage
    .from(bucket)
    .list(`apps/${world.app.id}/versions`);
  expect(ownerDownload.error).not.toBeNull();
  expect(anonDownload.error).not.toBeNull();
  expect(ownerList.data ?? []).toEqual([]);

  const { data: signed } = await admin.storage.from(bucket).createSignedUrl(path, 60);
  const fetched = await fetch(signed?.signedUrl as string);
  expect(fetched.status).toBe(200);
  expect(await fetched.text()).toBe("ixt-archive-bytes");

  const { data: bucketInfo } = await admin.storage.getBucket(bucket);
  expect(bucketInfo?.public).toBe(false);
  expect(bucketInfo?.file_size_limit).toBe(524_288_000);
  await admin.storage.from(bucket).remove([path]);

  recordOutcome("rls-private-07-storage-signed-only", {
    expectations: [
      "The private app-archives bucket (500 MiB limit) rejects direct upload, download and listing by a signed-in owner and by anon.",
      "An upload through a service-minted signed upload URL succeeds, and a service-minted signed download URL returns the exact bytes.",
    ],
    details: {
      directUpload: direct.error?.message,
      ownerDownload: ownerDownload.error?.message,
      anonDownload: anonDownload.error?.message,
      bucket: { public: bucketInfo?.public, fileSizeLimit: bucketInfo?.file_size_limit },
    },
  });
});
