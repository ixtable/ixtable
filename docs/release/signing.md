# Signing and release secrets

`.github/workflows/release.yml` signs every platform. When a `beta` or
`stable` run is missing any secret below, `scripts/release/signing.mjs` fails
the build and names the missing secrets (never their values). A `draft` run
warns and builds whatever it can sign. Without the updater key it builds no
updater artifacts.

## Updater key (all platforms)

| Secret | Use |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | minisign private key (contents of the `.key` file) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |

The public half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
The committed key is a **development key**, generated with
`npx tauri signer generate -w <path> --ci -p ""`. Before the first public
release:

1. Generate the production pair offline with a password:
   `npx tauri signer generate -w ixtable-updater.key`.
2. Put the private key and password in the secrets above. Keep an offline
   backup. A lost key cannot sign updates that installed apps accept.
3. Replace `plugins.updater.pubkey` with the new `.pub` contents (one base64
   line). Regenerate the fixtures in `src-tauri/src/updater/fixtures/` with
   `npx tauri signer sign` and the new key.

Rotating keys: ship one release, signed with the old key, whose
`tauri.conf.json` already has the new pubkey. Sign every release after that
with the new key.

## macOS (Developer ID + notarization)

| Secret | Use |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: ixtable Ltd (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | notarization: Apple ID, app-specific password, team |

The Tauri CLI imports the certificate into a temporary keychain. It signs with
the hardened runtime (`bundle.macOS.hardenedRuntime`) and the entitlements in
`src-tauri/entitlements.plist`, then notarizes and staples. The build is
universal (`--target universal-apple-darwin`). CI then runs `codesign
--verify --deep --strict`, `spctl --assess`, `stapler validate`, and `lipo`.

The DuckDB extensions are not in the bundle as Mach-O files. Upstream ships
them with only ad-hoc (linker) signatures, which notarization rejects, and
re-signing them would break both their SHA-256 pins and DuckDB's own extension
signature. The bundle holds the official `.duckdb_extension.gz` archives
instead (`bundle.resources` in `tauri.conf.json`). The app checks each archive
against its pinned hash, unpacks it into the per-user state directory on first
use, and checks the pinned hash of the result before `LOAD` (see
[the DuckDB read path record](../decisions/duckdb-read-path.md)).
`disable-library-validation` in the entitlements lets the hardened runtime
load the unpacked files. The release workflow fails if an uncompressed
`*.duckdb_extension` ends up in `ixtable.app`.

## Windows (Azure Trusted Signing)

Since June 2023, publicly trusted code-signing keys must be kept in hardware,
so a `.pfx` in a GitHub secret is no longer an option. ixtable uses
[Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)
through Tauri's `bundle.windows.signCommand`, which runs
`trusted-signing-cli` on every binary and installer:

| Secret | Use |
|---|---|
| `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` | service principal with the *Trusted Signing Certificate Profile Signer* role |
| `AZURE_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_CERTIFICATE_PROFILE` | certificate profile name |

`signCommand` is set only in the release `--config` override, so local
Windows builds do not need Azure. `tauri.conf.json` sets SHA-256 digests and a
timestamp server. CI checks `Get-AuthenticodeSignature` on `ixtable.exe` and
every `.exe` and `.msi` it builds.

An EV or OV certificate on a hardware token or cloud HSM can be used instead:
set `bundle.windows.certificateThumbprint` on a self-hosted runner where the
certificate is installed, and change `REQUIRED.windows` in
`scripts/release/signing.mjs` to match.

## Linux

AppImage, `.deb` and `.rpm` are built on Ubuntu 22.04, which keeps the glibc
requirement low. The updater uses the AppImage, which is signed with the
updater key. No other secret is needed.

## Release host (update manifests)

| Secret / variable | Use |
|---|---|
| `RELEASE_S3_BUCKET`, `RELEASE_S3_ENDPOINT` | S3-compatible bucket behind `releases.ixtable.app` |
| `RELEASE_S3_ACCESS_KEY_ID`, `RELEASE_S3_SECRET_ACCESS_KEY` | write credentials for that bucket |
| `vars.RELEASE_S3_REGION` | defaults to `auto` (R2) |
| `vars.RELEASE_BASE_URL` | defaults to `https://releases.ixtable.app` |

If any of the four secrets is missing, `publish-update-manifest` skips the
upload with a notice. The installers are still on the draft GitHub release.

## ixtable Cloud build values

The repository variables `IXTABLE_CLOUD_BUILD_URL`,
`IXTABLE_CLOUD_BUILD_ANON_KEY` and `IXTABLE_CLOUD_BUILD_SITE_URL` are compiled
into release builds (`cloud/config.rs`). The URL's origin is also added to the
release CSP (see [security.md](./security.md)).

## Local builds

`bundle.createUpdaterArtifacts` is on, so a full local `npm run tauri build`
needs an updater key. Either set `TAURI_SIGNING_PRIVATE_KEY` to a development
key, or turn the artifacts off:
`npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'`.
`--no-bundle` builds, as in Desktop CI, need neither.
