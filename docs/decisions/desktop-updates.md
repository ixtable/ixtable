# Desktop updates, signing, and webview CSP

## Status

Accepted. Covers PRD §6.1, §27.2 ("Signed bundles and updates must fail
closed") and the Phase 5 item "signed desktop installers and update channels
for all platforms". Production keys and the macOS DuckDB notarization fix are
pending (see Consequences).

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
- **Trust:** the minisign public key is in `plugins.updater.pubkey`. The
  plugin verifies before it installs. Endpoints are https only. The release
  pipeline verifies every artifact again before it publishes a manifest
  (`scripts/release/update-manifest.mjs`).
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

Details: `docs/release/updates.md`, `docs/release/signing.md`,
`docs/release/security.md`, `docs/release/checklist.md`.

## Consequences

- The committed pubkey is a development key. Before the first public release
  it must be replaced, and the test fixtures re-signed (`signing.md`).
- `requireSignedVersion` stays off until the Tauri CLI writes the version into
  signatures.
- macOS notarization will reject the ad-hoc-signed DuckDB extension Mach-O
  files in `resources/duckdb/macos-*`. The fix belongs to the DuckDB read
  path: ship them compressed and unpack them, with the hash checked, at first
  use.
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
- `tests/unit/updates-format.test.ts`, `tests/integration/updates.test.tsx`:
  the Updates tab, the save-before-install guard, signature-failure handling,
  and the start-up check.
