#!/usr/bin/env node
// Per-platform signing setup for release.yml `build`:
// - fails closed when a beta/stable run lacks any signing secret (names only, never values),
// - exports only the secrets that are set to $GITHUB_ENV (the Tauri CLI treats an empty
//   APPLE_CERTIFICATE as "import this"), and
// - writes the `tauri build --config` override (Windows signCommand, updater artifacts).
import { appendFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export const REQUIRED = {
  // minisign key for updater signatures (password may legitimately be empty).
  all: ["TAURI_SIGNING_PRIVATE_KEY"],
  macos: [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ],
  // Azure Trusted Signing through trusted-signing-cli (docs/release/signing.md).
  windows: [
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_TENANT_ID",
    "AZURE_SIGNING_ENDPOINT",
    "AZURE_SIGNING_ACCOUNT",
    "AZURE_CERTIFICATE_PROFILE",
  ],
  linux: [],
};
const OPTIONAL = ["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"];

export function requiredSecrets(platform) {
  if (!(platform in REQUIRED) || platform === "all")
    throw new Error(`Unknown platform ${platform}`);
  return [...REQUIRED.all, ...REQUIRED[platform]];
}

const present = (env, name) => typeof env[name] === "string" && env[name].trim() !== "";

export function missingSecrets(platform, env) {
  return requiredSecrets(platform).filter((name) => !present(env, name));
}

/** Release webviews talk to the IPC bridge and, when the build has one, the ixtable Cloud origin. */
export const RELEASE_CONNECT_SRC = "'self' ipc: http://ipc.localhost";

/** connect-src for a release build: the local Supabase origin of tauri.conf.json is dropped. */
export function releaseConnectSrc(cloudUrl) {
  if (!cloudUrl) return RELEASE_CONNECT_SRC;
  const url = new URL(cloudUrl);
  if (url.protocol !== "https:") throw new Error("IXTABLE_CLOUD_BUILD_URL must use https");
  return `${RELEASE_CONNECT_SRC} ${url.origin}`;
}

/** The `--config` override for `tauri build` on this platform. */
export function tauriConfigOverride(platform, env) {
  const app = {
    security: { csp: { "connect-src": releaseConnectSrc(env.IXTABLE_CLOUD_BUILD_URL) } },
  };
  const bundle = {};
  // Without the minisign key there is nothing to sign updater artifacts with (draft only).
  if (!present(env, "TAURI_SIGNING_PRIVATE_KEY")) bundle.createUpdaterArtifacts = false;
  if (platform === "windows" && REQUIRED.windows.every((name) => present(env, name)))
    bundle.windows = {
      signCommand: {
        cmd: "trusted-signing-cli",
        args: [
          "-e",
          env.AZURE_SIGNING_ENDPOINT,
          "-a",
          env.AZURE_SIGNING_ACCOUNT,
          "-c",
          env.AZURE_CERTIFICATE_PROFILE,
          "-d",
          "ixtable",
          "%1",
        ],
      },
    };
  return { app, bundle };
}

/** Names to export: required and optional secrets that are set (the key's password always travels with the key). */
export function exportedNames(platform, env) {
  const names = [...requiredSecrets(platform), ...OPTIONAL].filter((name) => present(env, name));
  if (
    present(env, "TAURI_SIGNING_PRIVATE_KEY") &&
    !names.includes("TAURI_SIGNING_PRIVATE_KEY_PASSWORD")
  )
    names.push("TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
  return names;
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const platform = arg("platform");
  const channel = arg("channel");
  const out = arg("out");
  const env = process.env;
  const missing = missingSecrets(platform, env);
  if (missing.length && channel !== "draft") {
    console.error(
      `::error::The ${channel} channel needs signing secrets for ${platform}: ${missing.join(", ")}`,
    );
    process.exit(1);
  }
  if (missing.length)
    console.log(
      `::warning::Draft build for ${platform} is not fully signed; missing ${missing.join(", ")}`,
    );
  if (env.GITHUB_ENV)
    for (const name of exportedNames(platform, env)) {
      const delimiter = `EOF_${randomBytes(12).toString("hex")}`;
      appendFileSync(env.GITHUB_ENV, `${name}<<${delimiter}\n${env[name] ?? ""}\n${delimiter}\n`);
    }
  if (out) writeFileSync(out, `${JSON.stringify(tauriConfigOverride(platform, env), null, 2)}\n`);
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `signed=${missing.length === 0}\nupdater=${present(env, "TAURI_SIGNING_PRIVATE_KEY")}\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
