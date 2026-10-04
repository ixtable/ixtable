import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { value } from "./helpers";

type Json = Record<string, unknown>;
const STATE = process.env.IXTABLE_STATE_DIR!;
const APP_ID = "0190c3f4-aaaa-7bbb-8ccc-0123456789ab";
const USER_ID = "0190c3f4-bbbb-7bbb-8ccc-0123456789ab";
const ROLE_ID = "0190c3f4-cccc-7bbb-8ccc-0123456789ab";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const { privateKey: otherKey } = generateKeyPairSync("ed25519");

const canonical = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const entries = Object.entries(v as Json)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, item]) => `${JSON.stringify(k)}:${canonical(item)}`).join(",")}}`;
};

const cloud = {
  archive: Buffer.alloc(0),
  version: "1.0.0",
  versionId: "v1",
  manifestPatch: {} as Json,
  owner: false,
  signer: privateKey,
  servedBytes: null as Buffer | null,
  grant: null as Json | null,
  grantError: null as { status: number; code: string } | null,
  envelope: null as Json | null,
  requests: [] as { name: string; body: Json; auth: string }[],
  uploaded: null as { url: string; bytes: Buffer } | null,
};

function manifestFor(body: Json) {
  const now = Date.now();
  const manifest = {
    format: "ixtable-cloud-bundle/1",
    appId: APP_ID,
    appName: "Field Notes",
    versionId: cloud.versionId,
    version: cloud.version,
    archiveSha256: createHash("sha256").update(cloud.archive).digest("hex"),
    archiveSize: cloud.archive.length,
    minRuntimeVersion: "0.0.0",
    userId: USER_ID,
    roleId: ROLE_ID,
    roleName: "Field worker",
    rolePermissions: {
      navigation: [],
      objects: [
        { kind: "table", id: "notes", read: true, create: true },
        { kind: "table", id: "tags", read: true },
      ],
      actions: [],
    },
    installationId: body.installationId,
    fingerprint: "a".repeat(64),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    ...(cloud.owner && { owner: true, roleId: null }),
  };
  const signed = canonical(manifest);
  const signature = sign(null, Buffer.from(signed), cloud.signer).toString("base64");
  const served = Object.keys(cloud.manifestPatch).length
    ? canonical({ ...manifest, ...cloud.manifestPatch })
    : signed;
  return { manifest: served, signature, archiveUrl: "/object/sign/app-archives/x.ixt?token=t" };
}

async function readBody(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const url = req.url ?? "";
  if (req.method === "PUT" && url.startsWith("/storage/v1/object/upload/sign/")) {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      cloud.uploaded = { url, bytes: Buffer.concat(chunks) };
      send(200, { Key: "app-archives/p.ixt" });
    });
    return;
  }
  if (url.startsWith("/storage/v1/object/sign/")) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(cloud.servedBytes ?? cloud.archive);
    return;
  }
  const name = url.replace("/functions/v1/", "");
  readBody(req).then((body) => {
    cloud.requests.push({ name, body, auth: String(req.headers.authorization ?? "") });
    if (name === "bundle-manifest") return send(200, manifestFor(body));
    if (name === "archive-upload-url")
      return send(200, {
        uploadId: "up-1",
        path: "apps/x/versions/p.ixt",
        signedUrl: "http://kong:8000/storage/v1/object/upload/sign/app-archives/p.ixt",
        token: "tok",
      });
    if (name === "credential-envelope") {
      cloud.envelope = body;
      return send(200, { envelopeId: "env-1" });
    }
    if (name === "key-grant") {
      if (cloud.grantError)
        return send(cloud.grantError.status, {
          error: { code: cloud.grantError.code, message: "Access revoked" },
        });
      return send(200, cloud.grant);
    }
    send(404, { error: { code: "NOT_FOUND", message: name } });
  });
}

const server = createServer(handle);
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.IXTABLE_CLOUD_URL = `http://127.0.0.1:${port}`;
  process.env.IXTABLE_CLOUD_ANON_KEY = "test-anon";
  process.env.IXTABLE_CLOUD_PUBLIC_KEY_RAW = (
    publicKey.export({ format: "der", type: "spki" }) as Buffer
  )
    .subarray(12)
    .toString("base64");
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const call = <T,>(command: string, args: Json = {}) =>
  invoke<T>(command, { windowLabel: "main", ...args });

async function archive(name: string, extra = false, datasource?: Json) {
  await call("new_document");
  const table = (tableName: string) =>
    call("create_database_table", {
      spec: {
        name: tableName,
        columns: [
          { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1, nullable: true },
          { name: "body", declaredType: "TEXT", primaryKeyPosition: 0, nullable: true },
        ],
        foreignKeys: [],
        checks: [],
        withoutRowid: false,
      },
    });
  await table("notes");
  const config = await call<Json>("read_document_config");
  await call("update_document_config", {
    config: {
      ...config,
      name: "Field Notes",
      entities: [{ id: "e1", table: "notes", concurrency: "optimistic" }],
      ...(datasource ? { datasource } : {}),
      migrations: extra
        ? [
            {
              id: "0190c3f4-eeee-7bbb-8ccc-0123456789ab",
              name: "Add tags",
              order: 1,
              targetStore: "sqlite",
              up: "CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)",
            },
          ]
        : [],
    },
  });
  if (extra) await call("apply_migrations");
  const path = join(STATE, name);
  await call("save_document_as", { path });
  await call("close_document", { force: true });
  return readFileSync(path);
}

const install = () =>
  call<{ runtimeOnly: boolean; bundleVersion: string }>("cloud_install_app", {
    accessToken: "user-jwt",
    appId: APP_ID,
    userId: USER_ID,
    email: "ada@example.test",
    transferId: "t1",
  });
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => "installed",
    (e: unknown) => String((e as Error).message ?? e),
  );
const notes = async () =>
  (
    await call<{ rows: { value?: unknown }[][] }>("read_table_page", {
      table: "notes",
      offset: 0,
      limit: 100,
      sorts: [],
      filters: [],
    })
  ).rows.map((row) => row[1]?.value);

it("installs a signed cloud bundle, rejects tampering, and updates keeping records", async () => {
  const v1 = await archive("field-v1.ixt");
  const v2 = await archive("field-v2.ixt", true);
  cloud.archive = v1;

  const state = await install();
  expect(state.runtimeOnly).toBe(true);
  expect(cloud.requests.at(-1)).toMatchObject({ name: "bundle-manifest", auth: "Bearer user-jwt" });
  const info = await call<Json>("cloud_runtime_info");
  expect(info).toMatchObject({
    appId: APP_ID,
    version: "1.0.0",
    roleId: ROLE_ID,
    roleName: "Field worker",
    email: "ada@example.test",
    userId: USER_ID,
  });
  expect(await call<unknown>("cloud_transfer_progress", { transferId: "t1" })).toMatchObject({
    phase: "downloaded",
    done: v1.length,
  });
  await call("insert_row", {
    table: "notes",
    values: [{ column: "body", value: value("text", "written at runtime") }],
  });
  expect(await failure(call("execute_read_query", { sql: "SELECT 1" }))).toMatch(/FORBIDDEN/);
  expect(
    await failure(
      call("delete_row", {
        table: "notes",
        identity: [value("integer", 1)],
        expected: [{ column: "body", value: value("text", "written at runtime") }],
      }),
    ),
  ).toMatch(/FORBIDDEN/);

  cloud.archive = v2;
  cloud.version = "1.1.0";
  cloud.versionId = "v2";
  cloud.manifestPatch = { roleId: "0190c3f4-dddd-7bbb-8ccc-0123456789ab" };
  expect(await failure(install())).toMatch(/MANIFEST_SIGNATURE/);
  cloud.manifestPatch = {};
  cloud.signer = otherKey;
  expect(await failure(install())).toMatch(/MANIFEST_SIGNATURE/);
  cloud.signer = privateKey;
  cloud.servedBytes = Buffer.concat([v2.subarray(0, -1), Buffer.from([v2.at(-1)! ^ 1])]);
  expect(await failure(install())).toMatch(/ARCHIVE_CHECKSUM/);
  cloud.servedBytes = null;
  cloud.manifestPatch = { expiresAt: new Date(Date.now() - 1000).toISOString() };
  expect(await failure(install())).toMatch(/MANIFEST_SIGNATURE|MANIFEST_EXPIRED/);
  cloud.manifestPatch = {};
  expect((await call<Json>("cloud_runtime_info")).version).toBe("1.0.0");
  expect(await notes()).toEqual(["written at runtime"]);

  const updated = await install();
  expect(updated.bundleVersion).toBe("1.1.0");
  expect(await notes()).toEqual(["written at runtime"]);
  const tables = await call<{ name: string }[]>("list_database_objects");
  expect(tables.map((t) => t.name).sort()).toEqual(["notes", "tags"]);
  expect(await failure(call("reset_runtime_installation_data", { confirmed: true }))).toMatch(
    /FORBIDDEN/,
  );
  expect(await call<Json>("runtime_installation_info")).toMatchObject({
    version: "1.1.0",
    appliedMigrations: ["Add tags"],
  });
  const [installed] = await call<Json[]>("cloud_installed_apps");
  expect(installed).toMatchObject({ appId: APP_ID, version: "1.1.0", versionId: "v2" });

  await call("close_document", { force: true });
  const offline = await call<{ bundleVersion: string }>("cloud_open_installed", { appId: APP_ID });
  expect(offline.bundleVersion).toBe("1.1.0");
  expect(await notes()).toEqual(["written at runtime"]);
  await call("close_document", { force: true });

  const appDir = join(STATE, "data", "cloud-installations", APP_ID);
  const docDir = readdirSync(appDir).find((d) => existsSync(join(appDir, d, "cloud.json")))!;
  const recordPath = join(appDir, docDir, "cloud.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  const signed = JSON.parse(record.signedManifest);
  record.signedManifest = canonical({ ...signed, owner: true, roleId: null });
  record.manifest = { ...record.manifest, owner: true, roleId: null };
  writeFileSync(recordPath, JSON.stringify(record));
  expect(await failure(call("cloud_open_installed", { appId: APP_ID }))).toMatch(
    /INSTALLATION_TAMPERED/,
  );
}, 120_000);

it("keeps the owner's access after resetting installation data", async () => {
  cloud.archive = await archive("owner.ixt");
  cloud.version = "1.5.0";
  cloud.versionId = "v-owner";
  cloud.owner = true;
  try {
    await install();
    await call("insert_row", {
      table: "notes",
      values: [{ column: "body", value: value("text", "before reset") }],
    });
    await call("reset_runtime_installation_data", { confirmed: true });
    expect(await notes()).toEqual([]);
    expect(await failure(call("execute_read_query", { sql: "SELECT 1" }))).toBe("installed");
  } finally {
    cloud.owner = false;
    await call("close_document", { force: true }).catch(() => undefined);
  }
}, 120_000);

it("delivers a PostgreSQL credential by envelope and key grant, memory only", async () => {
  const datasource = {
    kind: "postgres",
    id: "pg-main",
    host: "127.0.0.1",
    port: 1,
    database: "app",
    user: "runtime",
    sslmode: "require",
    credentialMode: "shared",
  };
  const bytes = await archive("pg.ixt", false, datasource);
  await call("open_document", { path: join(STATE, "pg.ixt") });
  const passwordRef = await call<string>("set_datasource_password", {
    datasourceId: "pg-main",
    password: "pg-secret-123",
    datasource,
  });
  const config = await call<Json>("read_document_config");
  await call("update_document_config", {
    config: { ...config, datasource: { ...datasource, passwordRef } },
  });
  await call("cloud_upload_credential", {
    accessToken: "dev-jwt",
    appId: APP_ID,
    scope: "shared",
    userId: null,
    password: null,
  });
  const envelope = cloud.envelope!;
  expect(envelope).toMatchObject({ appId: APP_ID, datasourceId: "pg-main", scope: "shared" });
  expect(JSON.stringify(envelope)).not.toContain("pg-secret-123");
  await call("close_document", { force: true });

  cloud.archive = bytes;
  cloud.version = "2.0.0";
  cloud.versionId = "pg-v1";
  await install();
  cloud.grant = {
    grantId: "g1",
    dek: envelope.dek,
    envelope: { ciphertext: envelope.ciphertext, nonce: envelope.nonce, aad: envelope.aad },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  const grant = await call<{ needed: boolean; expiresAt: string; attached: boolean }>(
    "cloud_key_grant",
    { accessToken: "user-jwt" },
  );
  expect(grant.needed).toBe(true);
  expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());
  expect(grant.attached).toBe(false);
  expect((await call<Json>("cloud_runtime_info")).grantExpiresAt).toBeTruthy();

  cloud.grant = { ...cloud.grant, envelope: { ...(cloud.grant.envelope as Json), aad: "x" } };
  expect(await failure(call("cloud_key_grant", { accessToken: "user-jwt" }))).toMatch(
    /CREDENTIAL_DECRYPT/,
  );

  cloud.grantError = { status: 403, code: "REVOKED" };
  expect(await failure(call("cloud_key_grant", { accessToken: "user-jwt" }))).toMatch(/REVOKED/);
  expect((await call<Json>("cloud_runtime_info")).grantExpiresAt).toBeNull();

  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  for (const file of files(join(STATE, "data", "cloud-installations")))
    expect(readFileSync(file).includes("pg-secret-123"), file).toBe(false);
  await call("close_document", { force: true });
}, 120_000);

it("uploads the saved archive for publishing and restores a version as a new local copy", async () => {
  await archive("publish.ixt");
  await call("open_document", { path: join(STATE, "publish.ixt") });
  const preflight = await call<{ blockers: string[]; security: Json; size: Json }>(
    "cloud_publish_preflight",
    { runtimeUsers: 3 },
  );
  expect(preflight.blockers).toEqual([]);
  expect(preflight.security).toMatchObject({ store: "sqlite", entityPoliciesResolved: true });
  expect(preflight.size).toMatchObject({ overCloudLimit: false, cloudLimitBytes: 500_000_000 });

  const upload = await call<{ uploadId: string; sha256: string; size: number }>(
    "cloud_upload_archive",
    { accessToken: "dev-jwt", appId: APP_ID, kind: "version", transferId: "up" },
  );
  const saved = readFileSync(join(STATE, "publish.ixt"));
  const sha = createHash("sha256").update(saved).digest("hex");
  expect(upload).toMatchObject({ uploadId: "up-1", sha256: sha, size: saved.length });
  expect(cloud.uploaded?.url).toBe("/storage/v1/object/upload/sign/app-archives/p.ixt?token=tok");
  expect(createHash("sha256").update(cloud.uploaded!.bytes).digest("hex")).toBe(sha);
  expect(cloud.requests.at(-1)?.body).toMatchObject({
    appId: APP_ID,
    kind: "version",
    sha256: sha,
  });

  const config = await call<Json>("read_document_config");
  await call("update_document_config", { config: { ...config, name: "Changed" } });
  expect(
    await failure(
      call("cloud_upload_archive", { accessToken: "t", appId: APP_ID, kind: "version" }),
    ),
  ).toMatch(/SAVE_REQUIRED/);

  const original = await call<{ documentId: string }>("document_state");
  cloud.servedBytes = saved;
  expect(
    await failure(
      call("cloud_restore_copy", {
        signedUrl: "/object/sign/app-archives/x.ixt?token=t",
        sha256: "0".repeat(64),
        size: saved.length,
        versionId: "v9",
      }),
    ),
  ).toMatch(/ARCHIVE_CHECKSUM/);
  const restored = await call<{ documentId: string; path: string | null; dirty: boolean }>(
    "cloud_restore_copy",
    {
      signedUrl: "/object/sign/app-archives/x.ixt?token=t",
      sha256: sha,
      size: saved.length,
      versionId: "v9",
    },
  );
  cloud.servedBytes = null;
  expect(restored.path).toBeNull();
  expect(restored.documentId).not.toBe(original.documentId);
  expect(await notes()).toEqual([]);
  await call("close_document", { force: true });
}, 120_000);
