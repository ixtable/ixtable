# Desktop updates, signing, and webview CSP

## Status

Accepted. Covers PRD §6.1, §27.2 ("Signed bundles and updates must fail
closed") and the Phase 5 item "signed desktop installers and update channels
for all platforms". The release pipeline takes production public keys from
CI variables and refuses beta and stable builds with a missing or development
key. Generating the production keys is a human gate (`key-ceremony` in
[the release gates](../release-checklist.md)) and is still pending.

## Context

ixtable ships on Windows, macOS and Linux, and every one blocks a release.
Users need updates that reach them without anyone running an installer by
hand. A compromised or broken update server must not be able to install code.
The webview can call every Tauri command, so what it may load has to be
limited too.

## Decision

- **Updater:** tauri-plugin-updater, driven from Rust (`src-tauri/src/updater/`)
  rather than from the plugin's JS API. The JS API only reads the static
  endpoints in `tauri.conf.json`. The Rust builder takes the endpoint for the
  user's channel (`updates.channel`: `stable` or `beta`). Commands:
  `update_settings`, `set_update_settings`, `check_for_update`,
  `install_update`, `update_progress`, `relaunch_app`. Relaunch uses
  `AppHandle::restart`, so `tauri-plugin-process` is not needed.
- **Trust:** the plugin verifies the minisign signature against
  `plugins.updater.pubkey` before it installs. Endpoints are https only. The
  committed `tauri.conf.json` holds a development key. Release builds replace
  it through the `tauri build --config` override with
  `vars.IXTABLE_UPDATER_PUBKEY` (`tauriConfigOverride` in
  `scripts/release/signing.mjs`). The pipeline verifies every artifact against
  that key again before it publishes a manifest
  (`scripts/release/update-manifest.mjs`), and `prepare` refuses to run
  against the development key.
- **Release key gate (fail closed):** `releaseKeyProblems` in
  `scripts/release/keys.mjs` runs in the `Signing setup` step. A beta or
  stable build stops before compiling when the updater pubkey or the cloud
  bundle-signing key is missing, malformed, or a known development or test
  key. Known keys are the committed updater key (compared by key bytes) and
  `scripts/release/dev-cloud-keys.json`: the RFC 8032 test vectors, the
  all-zero key, and every Ed25519 test key committed to the repository (a
  unit test fails when one is missing). The local Supabase stack key is
  random per checkout (`dev-secrets.mjs`) and never shared, so the list does
  not depend on `.env.local`; when that file exists it is checked too.
  `keys.mjs probe` signs a probe file with `TAURI_SIGNING_PRIVATE_KEY` and
  verifies it against the release pubkey, so a mismatched pair fails before
  the build. Draft runs only warn.
- **Fail closed in the build itself:** release.yml sets `IXTABLE_RELEASE=1`
  for beta and stable. With it, `src-tauri/build.rs`
  (`src/release_keys.rs`) fails the compile when the cloud key is missing,
  blank, malformed or in `dev-cloud-keys.json`, or when the updater pubkey
  (`tauri.conf.json` merged with the `TAURI_CONFIG` override from
  `--config`) is the committed development key. A local `tauri build`
  without the opt-in is a development build.
- **Binary check before upload:** tauri-action runs `tauri build` through
  `tauriScript: node scripts/release/keys.mjs`. The `build` wrapper checks
  that the binary contains the release cloud key and not the committed
  updater key, so a failure stops the job before tauri-action uploads to the
  draft release.
- **Hosting:** static `<channel>/latest.json` plus versioned payloads on an
  S3-compatible host, uploaded by the `publish-update-manifest` job after
  approval through a GitHub environment.
- **Unsaved work:** the Updates tab saves a titled document before it
  installs. For untitled work, or when the save fails, it asks first. The
  start-up check only shows a notice.
- **Installers:** `.github/workflows/release.yml` runs tauri-action with a
  universal macOS build (Developer ID, notarized), Windows signed with Azure
  Trusted Signing through `signCommand`, and Linux AppImage, deb and rpm.
  Beta and stable runs fail when any signing secret is missing.
- **CSP:** `script-src 'self'`, no eval, and IPC plus a single cloud origin in
  `connect-src`. Monaco is bundled instead of loaded from a CDN.

Details: `docs/release-checklist.md`, `docs/release/updates.md`, `docs/release/signing.md`,
`docs/release/security.md`, `docs/release/checklist.md`.

## Secrets and variables

Private keys live only in GitHub secrets and an offline backup. Public keys
are repository variables, because they are not secret and maintainers need to
read them.

| Name | Kind | Holds |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | production minisign private key and its password |
| `IXTABLE_UPDATER_PUBKEY` | variable | the matching `.pub` file contents (one base64 line) |
| `IXTABLE_CLOUD_PUBLIC_KEY_RAW` | variable | public half of the Edge Function secret `IXTABLE_CLOUD_SIGNING_KEY`, raw 32-byte Ed25519 key in base64 (`IXTABLE_CLOUD_PUBLIC_KEY`, SPKI DER base64, also works) |

Platform signing secrets (Apple, Azure) and the release host are listed in
`docs/release/signing.md`.

## Rotation

- **Updater key:** ship one release signed with the old private key, with
  `IXTABLE_UPDATER_PUBKEY` already set to the new pubkey. Then swap the two
  `TAURI_SIGNING_*` secrets. Installed apps trust only the key they were
  built with, so skipping that bridge release strands every installed copy.
  The probe step fails a run where the secret and variable do not match.
- **Cloud bundle-signing key:** set `IXTABLE_CLOUD_PUBLIC_KEY_RAW` to the new
  public key and ship a desktop release first. Then switch
  `IXTABLE_CLOUD_SIGNING_KEY` on the cloud (`docs/ops/production-config.md`).
  Desktops that have not updated refuse new bundles until they do (fail
  closed).
- **Compromised key:** rotate as above at once, and record the date, key
  fingerprints and operators in the incident log (`docs/ops/incidents.md`).
- The committed development key and its fixtures in
  `src-tauri/src/updater/fixtures/` never change for a rotation. They exist
  for tests only.

## Consequences

- The committed pubkey stays a development key permanently. Tests sign and
  verify against it, and the release gate refuses it, so it can never reach
  users.
- `requireSignedVersion` stays off until the Tauri CLI writes the version into
  signatures.
- The DuckDB extensions ship as `.duckdb_extension.gz` archives and are
  unpacked, hash-checked, at first use, so notarization never sees the
  ad-hoc-signed Mach-O files. `release.yml` fails if an uncompressed
  extension ends up in `ixtable.app`.
- Beta users who switch back to stable stay on their newer beta build until
  stable passes it. There are no downgrades.
- `style-src` keeps `'unsafe-inline'` because React, React Flow and Monaco
  set inline styles.

## Evidence

- `src-tauri/src/updater/tests.rs`: channels, endpoints, preference
  fallbacks, config consistency, and that a tampered package, a foreign key,
  or an edited trusted comment is rejected.
- `tests/unit/release-scripts.test.ts`: release plan, signing-secret gates,
  CSP rules, and manifest verification and rewriting.
- `tests/unit/release-keys.test.ts`: the release key gate (missing,
  malformed, and development keys in every encoding), the pubkey override,
  the embedded key check, the key pair probe with a generated key, and
  `prepare` refusing the development key.
- `tests/unit/release-gates.test.ts`: `scripts/ci/release-gates.mjs` and its
  match with `docs/release-checklist.md`.
- `tests/unit/updates-format.test.ts`, `tests/integration/updates.test.tsx`:
  the Updates tab, the save-before-install guard, signature-failure handling,
  and the start-up check.

## Audit log

- 2026-10-05: production public keys now come from CI variables with a
  fail-closed key gate, probe and embedded check. Added secret names and
  rotation. The DuckDB notarization item was already fixed (compressed
  extensions), so it moved out of the pending list.
