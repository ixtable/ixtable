// Decoders for the Edge Function replies Studio and the Runtime read
// (docs/decisions/cloud-architecture.md "Contract"). A reply missing a field
// the desktop needs fails with CLOUD_CONTRACT instead of surfacing later as
// `undefined`. tests/unit/cloud-contract.test.ts runs them on responses
// recorded from the local stack (web/e2e/service-qa/fixtures/contract).
import { CloudError } from "./errors";
import type { RestoreTarget } from "./types";

type Json = Record<string, unknown>;

function fail(name: string, path: string, expected: string): never {
  throw new CloudError(
    "CLOUD_CONTRACT",
    `ixtable Cloud answered ${name} without ${path} (${expected}). Update ixtable or try again later.`,
  );
}

function object(name: string, value: unknown, path: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(name, path, "an object");
  return value as Json;
}

function string(name: string, obj: Json, key: string, path = key): string {
  const value = obj[key];
  if (typeof value !== "string") fail(name, path, "a string");
  return value;
}

function nullableString(name: string, obj: Json, key: string, path = key): string | null {
  const value = obj[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(name, path, "a string or null");
  return value;
}

/** A version row (`app_versions`, snake_case) as returned by publish and resolve. */
export interface PublishedVersion {
  id: string;
  version: string;
  status: string;
}

function version(name: string, value: unknown): PublishedVersion {
  const row = object(name, value, "version");
  return {
    id: string(name, row, "id", "version.id"),
    version: string(name, row, "version", "version.version"),
    status: string(name, row, "status", "version.status"),
  };
}

function app(name: string, value: unknown): { id: string; name: string } {
  const row = object(name, value, "app");
  return { id: string(name, row, "id", "app.id"), name: string(name, row, "name", "app.name") };
}

export interface SyncCheck {
  upToDate: boolean;
  latest: { versionId: string; version: string; minRuntimeVersion: string | null } | null;
}

/** Replies the desktop reads, by function (inputs are built at the call sites). */
export interface DesktopReplies {
  "apps-create": { app: { id: string; name: string } };
  "roles-sync": Json;
  "publish-checkpoint": { version: PublishedVersion };
  "versions-resolve": {
    version: PublishedVersion | null;
    app: { id: string; name: string } | null;
  };
  "restore-url": RestoreTarget;
  "sync-check": SyncCheck;
  "backup-commit": { backup: { id: string } };
}
export type DesktopFunction = keyof DesktopReplies;

export const decoders: { [K in DesktopFunction]: (raw: unknown) => DesktopReplies[K] } = {
  "apps-create": (raw) => ({ app: app("apps-create", object("apps-create", raw, "reply").app) }),
  "roles-sync": (raw) => object("roles-sync", raw, "reply"),
  "publish-checkpoint": (raw) => ({
    version: version("publish-checkpoint", object("publish-checkpoint", raw, "reply").version),
  }),
  // overwrite → {version}; fork → {app, version}.
  "versions-resolve": (raw) => {
    const reply = object("versions-resolve", raw, "reply");
    return {
      version: reply.version == null ? null : version("versions-resolve", reply.version),
      app: reply.app == null ? null : app("versions-resolve", reply.app),
    };
  },
  "restore-url": (raw) => {
    const name = "restore-url";
    const reply = object(name, raw, "reply");
    if (typeof reply.size !== "number") fail(name, "size", "a number");
    if (typeof reply.isPostgres !== "boolean") fail(name, "isPostgres", "a boolean");
    return {
      signedUrl: string(name, reply, "signedUrl"),
      sha256: string(name, reply, "sha256"),
      size: reply.size,
      isPostgres: reply.isPostgres,
      warning: nullableString(name, reply, "warning"),
    };
  },
  "sync-check": (raw) => {
    const name = "sync-check";
    const reply = object(name, raw, "reply");
    if (typeof reply.upToDate !== "boolean") fail(name, "upToDate", "a boolean");
    const latest = reply.latest == null ? null : object(name, reply.latest, "latest");
    return {
      upToDate: reply.upToDate,
      latest: latest && {
        versionId: string(name, latest, "versionId", "latest.versionId"),
        version: string(name, latest, "version", "latest.version"),
        minRuntimeVersion: nullableString(
          name,
          latest,
          "minRuntimeVersion",
          "latest.minRuntimeVersion",
        ),
      },
    };
  },
  "backup-commit": (raw) => {
    const reply = object("backup-commit", raw, "reply");
    const backup = object("backup-commit", reply.backup, "backup");
    return { backup: { id: string("backup-commit", backup, "id", "backup.id") } };
  },
};
