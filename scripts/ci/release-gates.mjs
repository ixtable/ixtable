#!/usr/bin/env node
// Release gates (docs/release-checklist.md): PRD §27.2 security, §21.3 credential delivery, and
// the Phase 5 exit criteria. Checks every automatable gate against the repository and prints
// each human sign-off as PENDING. Exit 1 when an automated gate fails.
//   node scripts/ci/release-gates.mjs [--json]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readVersions } from "../release/plan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Crypto crates from established, reviewed implementations (PRD §21.3: no custom primitives). */
export const ALLOWED_CRYPTO_CRATES = [
  "argon2",
  "chacha20poly1305",
  "ed25519-dalek",
  "minisign-verify",
  "native-tls",
  "postgres-native-tls",
  "rand_core",
  "rustls",
  "sha2",
];
const CRYPTO_CRATE =
  /^(ring|rsa|ecdsa|p256|p384|hmac|hkdf|scrypt|pbkdf2|argon2|getrandom|sha2|sha1|sha3|md-?5|aes.*|.*crypt.*|.*cipher.*|chacha.*|.*poly1305|ed25519.*|x25519.*|curve25519.*|blake.*|.*tls.*|rand.*|minisign.*|.*sodium.*|openssl.*)$/;
const CRYPTO_NPM = /crypt|nacl|forge|noble|sodium|cipher|jsrsasign|elliptic/;

/** Dependency names from every `*dependencies*` table of a Cargo.toml. */
export function cargoDependencies(toml) {
  const names = [];
  let inDeps = false;
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line);
    if (header) inDeps = /dependencies/.test(header[1]);
    else if (inDeps) {
      const dep = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (dep) names.push(dep[1]);
    }
  }
  return names;
}

/** Crypto dependencies that are not on the allowlist. */
export function unreviewedCrypto(cargoToml, packageJson) {
  const cargo = cargoDependencies(cargoToml).filter(
    (name) => CRYPTO_CRATE.test(name) && !ALLOWED_CRYPTO_CRATES.includes(name),
  );
  const npm = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }).filter(
    (name) => CRYPTO_NPM.test(name),
  );
  return [...cargo, ...npm];
}

// PEM private keys, and Tauri/minisign secret key files (raw or base64, as `tauri signer generate`
// writes). Built at runtime so this file does not match its own scan.
const SECRET_KEY_COMMENT = ["untrusted comment:", "rsign encrypted secret key"].join(" ");
// Extended regular expressions, valid for both `git grep -E` and JavaScript.
const PRIVATE_KEY_PATTERNS = [
  "-----BEGIN ([A-Z]+ )?PRIVATE KEY-----",
  SECRET_KEY_COMMENT.replace("rsign", "(rsign|minisign)"),
  Buffer.from(SECRET_KEY_COMMENT).toString("base64").slice(0, 56),
];
const PRIVATE_KEY_MARKERS = PRIVATE_KEY_PATTERNS.map((pattern) => new RegExp(pattern));
const PRIVATE_KEY_FILE = /\.(p12|pfx|p8|keystore|jks)$|(^|\/)[^/]*\.key$/i;

/** Tracked files that hold, or are named like, private keys. `read(path)` returns text or null. */
export function committedPrivateKeys(files, read) {
  return files.filter((file) => {
    if (PRIVATE_KEY_FILE.test(file)) return true;
    const text = read(file);
    return text !== null && PRIVATE_KEY_MARKERS.some((marker) => marker.test(text));
  });
}

const file = (root, path) => readFileSync(join(root, path), "utf8");

/** Fails with the names of evidence files that are missing or lack the expected text. */
function evidence(root, expected) {
  const problems = [];
  for (const [path, pattern] of Object.entries(expected)) {
    if (!existsSync(join(root, path))) problems.push(`${path} is missing`);
    else if (pattern && !pattern.test(file(root, path)))
      problems.push(`${path} no longer contains ${pattern}`);
  }
  return problems;
}

const THREE_OS =
  /ubuntu[^\]]*macos-latest[^\]]*windows-latest|\[ubuntu-latest, macos-latest, windows-latest\]/;

/**
 * Every gate. `check(root)` returns a list of problems (empty = pass); gates without `check`
 * need a human sign-off, recorded as described in `signoff`.
 */
export const GATES = [
  {
    id: "no-plaintext-credentials",
    prd: "§27.2",
    title: "No plaintext datasource credentials in an unencrypted archive entry",
    check: (root) =>
      evidence(root, {
        "src-tauri/src/recordstore/secrets.rs": /chacha20poly1305|XChaCha20Poly1305/i,
        "tests/integration/datasource.test.tsx": /without storing the password in the document/,
      }),
  },
  {
    id: "no-custom-crypto",
    prd: "§21.3, §27.2",
    title: "Crypto comes only from established crates (no custom primitives)",
    check: (root) =>
      unreviewedCrypto(
        file(root, "src-tauri/Cargo.toml"),
        JSON.parse(file(root, "package.json")),
      ).map((name) => `${name} is not on ALLOWED_CRYPTO_CRATES; review it before adding`),
  },
  {
    id: "updates-fail-closed",
    prd: "§27.2",
    title: "Signed updates fail closed (signature, key pair, and dev-key gates)",
    check: (root) => {
      const problems = evidence(root, {
        ".github/workflows/release.yml":
          /scripts\/release\/signing\.mjs[\s\S]*keys\.mjs probe[\s\S]*keys\.mjs embedded[\s\S]*update-manifest\.mjs verify/,
        "scripts/release/keys.mjs": /export function releaseKeyProblems/,
        "src-tauri/src/updater/tests.rs": /foreign|other_key|other-key/,
      });
      const conf = JSON.parse(file(root, "src-tauri/tauri.conf.json"));
      for (const url of conf.plugins?.updater?.endpoints ?? [])
        if (!url.startsWith("https://")) problems.push(`updater endpoint ${url} is not https`);
      return problems;
    },
  },
  {
    id: "bundles-fail-closed",
    prd: "§27.2",
    title: "Signed cloud bundles fail closed (no pinned key refuses every install)",
    check: (root) =>
      evidence(root, {
        "src-tauri/src/cloud/config.rs": /CLOUD_KEY_MISSING/,
        ".github/workflows/release.yml":
          /IXTABLE_CLOUD_PUBLIC_KEY_RAW: \$\{\{ vars\.IXTABLE_CLOUD_PUBLIC_KEY_RAW \}\}/,
      }),
  },
  {
    id: "no-committed-private-keys",
    prd: "§27.2",
    title: "No private signing key is committed",
    check: (root) => {
      const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
      const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);
      // One git grep over the tracked text files: reading ~1000 files from Node is slow on Windows.
      const patterns = PRIVATE_KEY_PATTERNS.flatMap((pattern) => ["-e", pattern]);
      let matched = [];
      try {
        matched = git(["grep", "-l", "-z", "-I", "-E", ...patterns])
          .split("\0")
          .filter(Boolean);
      } catch (error) {
        // Exit status 1 means no match; anything else is a real failure.
        if (error.status !== 1) throw error;
      }
      const flagged = new Set([...files.filter((path) => PRIVATE_KEY_FILE.test(path)), ...matched]);
      return [...flagged].sort().map((path) => `${path} looks like a private key`);
    },
  },
  {
    id: "private-by-default",
    prd: "§27.2",
    title: "Cloud applications are private by default",
    check: (root) =>
      evidence(root, {
        "web/e2e/service-qa/specs/rls-private-by-default.spec.ts": null,
        ".github/workflows/cloud.yml": /service-qa:contracts/,
      }),
  },
  {
    id: "runtime-authorization",
    prd: "§27.2",
    title: "Authorization checks at every Runtime object and action entry point",
    check: (root) =>
      evidence(root, {
        "tests/integration/runtime-rbac.test.tsx": null,
        "tests/integration/runtime-rbac-triggers.test.tsx": null,
        "src-tauri/src/trigger_auth_tests.rs": null,
      }),
  },
  {
    id: "log-redaction",
    prd: "§27.2",
    title: "Sensitive values are redacted from logs and crash reports",
    check: (root) =>
      evidence(root, { "src-tauri/src/logging.rs": /pub fn redact[\s\S]*#\[test\]/ }),
  },
  {
    id: "key-renewal-24h",
    prd: "§21.3",
    title: "Key grants expire after 24 hours",
    check: (root) =>
      evidence(root, {
        "supabase/functions/_shared/credentials.ts": /GRANT_TTL_MS = 24 \* 60 \* 60 \* 1000/,
      }),
  },
  {
    id: "three-os-ci",
    prd: "§6.1, Phase 5",
    title: "Tests and golden suites run on Windows, macOS, and Linux",
    check: (root) => {
      const problems = [];
      const desktop = file(root, ".github/workflows/desktop.yml");
      const matrices = desktop.match(/os: \[[^\]]+\]/g) ?? [];
      if (matrices.filter((m) => THREE_OS.test(m)).length < 2)
        problems.push("desktop.yml test and golden jobs must both run on all three OSes");
      if (
        !/os: \[ubuntu-22\.04, macos-latest, windows-latest\]/.test(
          file(root, ".github/workflows/release.yml"),
        )
      )
        problems.push("release.yml gates must run on all three OSes");
      return problems;
    },
  },
  {
    id: "signed-installers",
    prd: "Phase 5",
    title: "Signed installers and update channels for all platforms",
    check: (root) =>
      evidence(root, {
        ".github/workflows/release.yml":
          /codesign --verify[\s\S]*stapler validate[\s\S]*Get-AuthenticodeSignature/,
        "scripts/release/signing.mjs": /APPLE_CERTIFICATE[\s\S]*AZURE_CERTIFICATE_PROFILE/,
        "scripts/release/update-manifest.mjs": /REQUIRED_PLATFORMS/,
      }),
  },
  {
    id: "versions-agree",
    prd: "Phase 5",
    title: "tauri.conf.json, package.json, and Cargo.toml carry one version",
    check: (root) => {
      const v = readVersions(root);
      return v.tauri === v.npm && v.npm === v.cargo
        ? []
        : [`versions differ: tauri ${v.tauri}, npm ${v.npm}, cargo ${v.cargo}`];
    },
  },
  {
    id: "operations-docs",
    prd: "Phase 5",
    title: "Security, monitoring, backup, incident, and support documentation exists",
    check: (root) =>
      evidence(root, {
        "docs/release/security.md": null,
        "docs/ops/monitoring.md": null,
        "docs/ops/backups.md": null,
        "docs/ops/incidents.md": null,
        "docs/ops/support-runbook.md": null,
        "docs/ops/production-config.md": null,
      }),
  },
  {
    id: "external-security-review",
    prd: "§21.3, §27.2",
    title: "Independent security review of the envelope-encryption and signed-bundle design",
    signoff:
      "Security lead files the reviewer's report and the fix list in docs/decisions/cloud-security-model.md",
  },
  {
    id: "key-ceremony",
    prd: "§27.2, Phase 5",
    title: "Production keys generated offline and loaded into CI",
    signoff:
      "Two maintainers generate the updater and cloud signing keys, set the secrets and variables in docs/decisions/desktop-updates.md, and record the ceremony",
  },
  {
    id: "green-ci-all-os",
    prd: "Phase 5, §29",
    title:
      "Desktop and Cloud contracts CI green on Windows, macOS, and Linux for the release commit",
    signoff: "Release manager links the green runs in the release issue",
  },
  {
    id: "install-signoff",
    prd: "Phase 5",
    title: "Installers and the update path checked by hand on each OS",
    signoff: "Release manager completes docs/release/checklist.md section 3 for all three OSes",
  },
  {
    id: "production-cloud-config",
    prd: "§27.2, Phase 5",
    title: "Production ixtable Cloud settings checked before go-live",
    signoff: "Operator completes the go-live list in docs/ops/production-config.md",
  },
  {
    id: "self-service-journey",
    prd: "Phase 5",
    title:
      "A new customer can register, pay, publish, invite, run, update, restore, and cancel unaided",
    signoff: "Product owner runs the journey on production and records the evidence",
  },
  {
    id: "support-without-secrets",
    prd: "Phase 5",
    title: "Support can diagnose distribution and key-grant failures without viewing secrets",
    signoff: "Support lead walks through docs/ops/support-runbook.md on a staged failure",
  },
  {
    id: "commercial-terms",
    prd: "Phase 5",
    title: "Commercial terms reflect the trusted-user security model",
    signoff: "Legal approves the terms and privacy policy",
  },
];

/** Runs every gate: { id, prd, title, status: "pass" | "fail" | "pending", detail }. */
export function runGates(root = ROOT, gates = GATES) {
  return gates.map(({ id, prd, title, check, signoff }) => {
    if (!check) return { id, prd, title, status: "pending", detail: signoff };
    try {
      const problems = check(root);
      return {
        id,
        prd,
        title,
        status: problems.length ? "fail" : "pass",
        detail: problems.join("; "),
      };
    } catch (error) {
      return { id, prd, title, status: "fail", detail: error.message };
    }
  });
}

function main() {
  const results = runGates();
  if (process.argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
  else
    for (const r of results)
      console.log(
        `${r.status.toUpperCase().padEnd(7)} ${r.id} (${r.prd}): ${r.title}${r.detail ? `\n        ${r.detail}` : ""}`,
      );
  const count = (status) => results.filter((r) => r.status === status).length;
  console.log(
    `\n${count("pass")} passed, ${count("fail")} failed, ${count("pending")} pending human sign-off`,
  );
  if (count("fail")) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
