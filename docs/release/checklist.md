# Release checklist

PRD §6.1 makes Windows, macOS and Linux all release-blocking. PRD Phase 5 asks
for signed installers and update channels on every platform. A release ships
only when every gate below is checked for all three platforms.

## 1. Prepare

- [ ] The version is bumped in `src-tauri/tauri.conf.json`, `package.json`
      and `src-tauri/Cargo.toml` (the `plan` job fails when they differ).
- [ ] The tag matches: `vX.Y.Z` for stable, `vX.Y.Z-beta.N` for beta.
- [ ] `Desktop` CI is green on the tagged commit. It includes the archive
      upgrade fixtures (`tests/fixtures/archives/`) and the forced-termination
      autosave test (`src-tauri/src/durability_tests/`) on all three OSes.
      Each golden job uploads its journey evidence as `golden-evidence-<os>`.
- [ ] `Cloud contracts` CI (`.github/workflows/cloud.yml`) is green for the
      last change to `supabase/**` or the cloud clients.
- [ ] If this release bumps the archive `FORMAT_VERSION`, a new
      `tests/fixtures/archives/format-<N>/` is committed
      (`node scripts/ci/write-archive-fixtures.mjs`) and no older fixture
      directory changed.
- [ ] The 500 MB boundary test passed on all three OSes: the `test` job's
      "500 MB archive boundary" step (locally,
      `IXTABLE_HEAVY_TESTS=1 cargo test --lib durability_tests::heavy` in
      `src-tauri`). PostgreSQL conformance passed on all three (`postgres`
      and `postgres-native`).
- [ ] Release notes are written in the draft release body before approving
      step 4. `publish-update-manifest` copies them into `latest.json`
      `notes`, which Settings → Updates shows.

## 2. Build (automatic: `.github/workflows/release.yml`)

Pushing the tag runs these gates. Any failure stops the release.

| Gate | Windows | macOS | Linux |
|---|---|---|---|
| Typecheck, lint | | | `gates` |
| Rust, unit, integration tests | `gates` | `gates` | `gates` |
| Golden application suites (`tests/integration/golden`) | `gates` | `gates` | `gates` |
| DuckDB sqlite + postgres scanners fetched and hash-checked | `build` | `build` (arm64 + x64) | `build` |
| Signing secrets present (beta/stable fail closed) | `build` | `build` | `build` |
| Installers signed | Authenticode `Valid` on exe/msi | `codesign --verify --deep --strict`, `spctl` | — |
| Notarized and stapled | — | `stapler validate` on each dmg | — |
| Universal binary | — | `lipo` shows arm64 + x86_64 | — |
| Updater signatures verify against `plugins.updater.pubkey` | `build` | `build` | `build` |
| Smoke launch (app stays up 20 s with a fresh state dir) | `build` | `build` | `build` (xvfb) |

## 3. Manual sign-off (before approving `publish-update-manifest`)

Download the installers from the draft release, then on each OS:

- [ ] **Windows:** run the NSIS installer on a clean VM. SmartScreen shows the
      ixtable publisher. Open a golden `.ixt`, then a `.ixtr` bundle.
- [ ] **macOS (Apple silicon and Intel):** open the dmg with no Gatekeeper
      warning. Open a golden `.ixt`. Connect a PostgreSQL datasource, which
      loads the postgres scanner under the hardened runtime.
- [ ] **Linux:** install the `.deb` (Ubuntu) and the `.rpm` (Fedora), and run
      the AppImage. Opening `.ixt` from the file manager uses ixtable.
- [ ] **Update path:** install the previous release, set the channel in
      Settings → Updates, and check. The new version is offered. With unsaved
      changes, **Install and relaunch** saves them first and relaunches into
      the new version.
- [ ] **Fail-closed:** on one platform, point `IXTABLE_UPDATE_BASE_URL` at a
      staging manifest whose signature belongs to another file. The install
      fails with `UPDATE_SIGNATURE_INVALID` and the app stays on the old
      version.

## 4. Publish

- [ ] Approve the `release-<channel>` environment. `publish-update-manifest`
      checks every signature again, uploads the payloads, and uploads
      `latest.json` last. A stable release also updates `beta` unless beta is
      already ahead.
- [ ] Publish the GitHub draft release.
- [ ] Check `https://releases.ixtable.app/<channel>/latest.json`: the version is
      right, all four platforms are listed, and every URL resolves.

## Rollback

Updates only ever move forward. To pull a bad release, upload the previous
`latest.json` again, so no more installs pick up the bad version. Then ship a
fixed `X.Y.Z+1`. Users already on the bad version update to it.
