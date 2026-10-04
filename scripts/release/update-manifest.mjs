#!/usr/bin/env node
// Updater manifest tooling for release.yml (fail-closed):
//   verify <file>...      check each file's `.sig` against the pubkey in tauri.conf.json
//   prepare ...           verify every platform in tauri-action's latest.json, then lay out
//                         <out>/<channel>/<version>/<payloads> and <out>/<channel>/latest.json
//                         with URLs on the release host.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareVersions } from "./plan.mjs";

/** Platforms every channel manifest must cover (PRD Phase 5: all three OSes). */
export const REQUIRED_PLATFORMS = [
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
  "windows-x86_64",
];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function configuredPubkey(root = ROOT) {
  const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const key = conf.plugins?.updater?.pubkey;
  if (!key) throw new Error("tauri.conf.json has no plugins.updater.pubkey");
  return key;
}

const lines = (b64) => Buffer.from(b64.trim(), "base64").toString("utf8").split(/\r?\n/);

function decodeKey(pubkeyB64) {
  const raw = Buffer.from(lines(pubkeyB64)[1] ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed")
    throw new Error("Malformed minisign public key");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw.subarray(10)]);
  return {
    id: raw.subarray(2, 10),
    key: createPublicKey({ key: spki, format: "der", type: "spki" }),
  };
}

/**
 * Verifies a Tauri updater signature (base64 of a minisign signature file) the
 * way tauri-plugin-updater does: key id, Ed25519 over BLAKE2b-512 of the data
 * ("ED"), and the global signature over the trusted comment. Throws on failure.
 */
export function verifySignature(data, signatureB64, pubkeyB64) {
  const { id, key } = decodeKey(pubkeyB64);
  const text = lines(signatureB64 ?? "");
  const sig = Buffer.from(text[1] ?? "", "base64");
  const trusted = text[2]?.startsWith("trusted comment: ") ? text[2].slice(17) : null;
  const global = Buffer.from(text[3] ?? "", "base64");
  if (sig.length !== 74 || trusted === null || global.length !== 64)
    throw new Error("Malformed minisign signature");
  const algorithm = sig.subarray(0, 2).toString();
  // Stricter than the plugin (which also accepts legacy "Ed"): the Tauri CLI always prehashes.
  if (algorithm !== "ED") throw new Error(`Unsupported signature algorithm ${algorithm}`);
  if (!sig.subarray(2, 10).equals(id)) throw new Error("Signed by a different key");
  const digest = createHash("blake2b512").update(data).digest();
  if (!edVerify(null, digest, key, sig.subarray(10)))
    throw new Error("Signature does not match the file");
  if (!edVerify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), key, global))
    throw new Error("Trusted comment signature is invalid");
  return trusted;
}

/**
 * Rewrites tauri-action's latest.json for the release host after checking that
 * every required platform has an https URL and a signature that verifies.
 * `readPayload(fileName)` returns the bytes of a downloaded release asset.
 */
export function prepareManifest(manifest, { channel, baseUrl, pubkey, readPayload }) {
  if (!manifest?.version || !manifest.platforms)
    throw new Error("latest.json has no version or platforms");
  const version = String(manifest.version).replace(/^v/, "");
  const missing = REQUIRED_PLATFORMS.filter((p) => !manifest.platforms[p]);
  if (missing.length) throw new Error(`latest.json is missing platforms: ${missing.join(", ")}`);
  const base = baseUrl.replace(/\/+$/, "");
  if (!base.startsWith("https://")) throw new Error("The release host must use https");
  const files = new Map();
  const platforms = {};
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    if (!entry?.url?.startsWith("https://")) throw new Error(`${platform}: url must use https`);
    if (!entry.signature) throw new Error(`${platform}: missing signature`);
    const file = decodeURIComponent(basename(new URL(entry.url).pathname));
    try {
      verifySignature(readPayload(file), entry.signature, pubkey);
    } catch (error) {
      throw new Error(`${platform} (${file}): ${error.message}`, { cause: error });
    }
    files.set(file, `${channel}/${version}/${file}`);
    platforms[platform] = {
      signature: entry.signature,
      url: `${base}/${channel}/${version}/${encodeURIComponent(file)}`,
    };
  }
  return { manifest: { ...manifest, version, platforms }, files };
}

/** Stable releases also go to beta unless beta already offers something newer. */
export function channelsFor(channel, version, currentBetaVersion) {
  if (channel !== "stable") return [channel];
  if (currentBetaVersion && compareVersions(currentBetaVersion, version) >= 0) return ["stable"];
  return ["stable", "beta"];
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const pubkey = configuredPubkey();
  if (command === "verify") {
    // `verify --json '[paths]'` takes tauri-action's artifactPaths output.
    const paths = rest[0] === "--json" ? JSON.parse(rest[1]) : rest;
    const files = paths.filter((f) => existsSync(`${f}.sig`));
    if (!files.length) throw new Error("No updater artifacts with .sig files to verify");
    for (const file of files) {
      verifySignature(readFileSync(file), readFileSync(`${file}.sig`, "utf8"), pubkey);
      console.log(`verified ${basename(file)}`);
    }
    return;
  }
  if (command !== "prepare")
    throw new Error(
      "usage: update-manifest.mjs verify <files…> | prepare --manifest f --assets d --channel c --base url --out d [--beta-current v] [--notes file]",
    );
  const assets = arg("assets");
  const out = arg("out");
  const channel = arg("channel");
  const source = JSON.parse(readFileSync(arg("manifest"), "utf8"));
  // Notes come from the GitHub release body as edited before approval.
  if (arg("notes")) source.notes = readFileSync(arg("notes"), "utf8").trim();
  for (const target of channelsFor(
    channel,
    String(source.version).replace(/^v/, ""),
    arg("beta-current"),
  )) {
    const { manifest, files } = prepareManifest(source, {
      channel: target,
      baseUrl: arg("base"),
      pubkey,
      readPayload: (file) => readFileSync(join(assets, file)),
    });
    for (const [file, key] of files) {
      mkdirSync(dirname(join(out, key)), { recursive: true });
      copyFileSync(join(assets, file), join(out, key));
    }
    writeFileSync(join(out, target, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`prepared ${target}/latest.json for ${manifest.version} (${files.size} payloads)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
