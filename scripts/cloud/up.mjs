#!/usr/bin/env node
// Brings up the local ixtable Cloud stack for development and service-qa:
//   1. Docker reachable (starts dockerd when running as root without one).
//   2. Local Edge secrets (dev-secrets.mjs) in supabase/functions/.env(.local)
//      and the functions' npm dependencies in supabase/functions/node_modules
//      (the Edge runtime resolves them there instead of the registry).
//   3. `supabase start` without the services ixtable does not use.
//   4. `supabase db reset` (skip with --no-reset).
//   5. Health gate: GET /functions/v1/health returns {ok:true}.
//
//   node scripts/cloud/up.mjs [--no-reset] [--restart]
//
// --restart stops the stack first (needed after editing config.toml or the
// function secrets, which `supabase start` only reads at boot).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDevSecrets } from "./dev-secrets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = new Set(process.argv.slice(2));
export const EXCLUDED_SERVICES = [
  "studio",
  "realtime",
  "imgproxy",
  "vector",
  "logflare",
  "supavisor",
  "postgres-meta",
];
const API_URL = "http://127.0.0.1:54321";

function log(message) {
  console.log(`[cloud:up] ${message}`);
}

function run(command, commandArgs, options = {}) {
  log(`${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} exited with ${result.status}`);
  }
}

function succeeds(command, commandArgs) {
  return spawnSync(command, commandArgs, { cwd: root, stdio: "ignore" }).status === 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureDocker() {
  if (succeeds("docker", ["info"])) return;
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!isRoot || !succeeds("which", ["dockerd"])) {
    throw new Error(
      "Docker is not reachable. Start Docker Desktop (or the docker daemon) and retry.",
    );
  }
  log("starting dockerd (log: /tmp/dockerd.log)");
  const out = openSync("/tmp/dockerd.log", "a");
  spawn("dockerd", [], { detached: true, stdio: ["ignore", out, out] }).unref();
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (succeeds("docker", ["info"])) return;
  }
  throw new Error("dockerd did not become ready within 60s; see /tmp/dockerd.log");
}

// Nested Docker (cloud agent VMs): containers on the Supabase bridge cannot
// reach each other while bridge netfilter is on. Best effort, Linux only.
function relaxBridgeNetfilter() {
  for (const name of ["bridge-nf-call-iptables", "bridge-nf-call-ip6tables"]) {
    const path = `/proc/sys/net/bridge/${name}`;
    try {
      if (existsSync(path)) writeFileSync(path, "0");
    } catch {
      // Not permitted outside nested Docker; harmless.
    }
  }
}

// Reuse an already pulled Postgres 17 image instead of pulling the CLI's
// newest default (the image is ~3.5 GB). Writes the gitignored
// supabase/.temp/postgres-version only when none is set.
function pinCachedPostgres() {
  const pinFile = join(root, "supabase", ".temp", "postgres-version");
  if (existsSync(pinFile)) return;
  let tags;
  try {
    tags = execFileSync(
      "docker",
      ["images", "public.ecr.aws/supabase/postgres", "--format", "{{.Tag}}"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((tag) => tag.startsWith("17."));
  } catch {
    return;
  }
  if (tags.length === 0) return;
  mkdirSync(dirname(pinFile), { recursive: true });
  writeFileSync(pinFile, tags[0]);
  log(`reusing cached postgres image ${tags[0]}`);
}

export async function waitForHealth(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/functions/v1/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      if (response.ok && JSON.parse(body).ok === true) return JSON.parse(body);
      last = `HTTP ${response.status} ${body.slice(0, 200)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(2000);
  }
  throw new Error(`health gate failed: ${last}`);
}

async function main() {
  if (!succeeds("supabase", ["--version"])) {
    throw new Error(
      "Supabase CLI not found. Install: https://supabase.com/docs/guides/local-development/cli/getting-started",
    );
  }
  await ensureDocker();
  relaxBridgeNetfilter();
  const { created } = ensureDevSecrets();
  log(`${created ? "generated" : "kept"} supabase/functions/.env.local`);
  run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund", "--prefix", "supabase/functions"], {
    shell: process.platform === "win32",
  });
  if (args.has("--restart")) run("supabase", ["stop"]);
  pinCachedPostgres();
  if (succeeds("supabase", ["status"])) {
    log("stack already running (use --restart after config or secret changes)");
  } else {
    run("supabase", ["start", "-x", EXCLUDED_SERVICES.join(",")]);
  }
  if (!args.has("--no-reset")) run("supabase", ["db", "reset", "--local"]);
  const health = await waitForHealth();
  log(`healthy: ${JSON.stringify(health)}`);
  log(
    `API ${API_URL} · DB postgresql://postgres:postgres@127.0.0.1:54322/postgres · Mailpit http://127.0.0.1:54324`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`[cloud:up] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
