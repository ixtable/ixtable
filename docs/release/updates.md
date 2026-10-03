# In-app updates

ixtable updates itself through
[tauri-plugin-updater](https://v2.tauri.app/plugin/updater/), driven from Rust
in `src-tauri/src/updater/`. The UI is Settings → Updates (`src/updates/`).

## Channels and endpoints

| Channel | Manifest URL | Gets |
|---|---|---|
| `stable` (default) | `https://releases.ixtable.app/stable/latest.json` | tags `vX.Y.Z` |
| `beta` | `https://releases.ixtable.app/beta/latest.json` | tags `vX.Y.Z-pre`, plus every stable release newer than the current beta |

- The channel is the global preference `updates.channel`. Auto-check on start
  is `updates.autoCheck` (default on). Unknown stored values fall back to
  `stable` and on.
- The app appends `?target={{target}}&arch={{arch}}&current_version={{current_version}}`.
  The plugin fills these in. A static host ignores them. A dynamic host could
  use them later without an app change.
- `IXTABLE_UPDATE_BASE_URL` replaces the host for staging or QA. It must be
  `https://`.
- The plugin only offers versions newer than the running one. Switching from
  beta back to stable does not downgrade. The user stays on the beta build
  until stable passes it.

## Flow

1. `check_for_update` asks the selected channel and keeps the result in memory.
   Nothing is downloaded.
2. The user clicks **Install and relaunch**. Before the install starts, the
   Updates tab protects open work:
   - A saved document with changes is saved in place, which is what autosave
     would do.
   - An untitled document, or a failed save, asks the user. **Save and
     install** saves first, and Save As if needed. **Cancel** stops the
     install. If the work is still unsaved, nothing installs.
3. `install_update` downloads the package and verifies its signature, then
   installs it. The UI polls `update_progress`.
4. `relaunch_app` restarts the app on macOS and Linux. On Windows the passive
   NSIS installer closes and restarts the app.

The start-up check only shows a notice ("ixtable X is available") with
**Review update**. It never downloads or installs anything without the user.

## Fail-closed signature verification

PRD §27.2: "Signed bundles and updates must fail closed."

- `tauri.conf.json` `plugins.updater.pubkey` is the minisign public key. The
  private key exists only in the release secrets.
- In `Update::download`, tauri-plugin-updater 2.13 reads the whole package and
  then calls `verify_signature(...)?`. That function decodes the key, decodes
  the signature, and runs `PublicKey::verify(data, signature, true)` (the flag allows legacy non-prehashed signatures; CI refuses those). Any
  error returns before `install` gets the bytes. An empty, missing, or
  malformed signature is a decode error. A different key, changed bytes, or an
  edited trusted comment fail the check.
- The plugin refuses non-https endpoints in release builds
  (`InsecureTransportProtocol`). `endpoint()` refuses them in every build.
  `tauri.conf.json` sets none of the `dangerous*` flags, and a test enforces
  that.
- Errors become `UPDATE_SIGNATURE_INVALID`. The UI says the package was
  rejected and does not relaunch.
- `requireSignedVersion` is off for now. Tauri CLI 2.11 does not yet write
  `version:` into the trusted comment. Turn it on once the CLI writes it.
  It stops an old, validly signed package from being served under a newer
  version number.

Evidence:

- `src-tauri/src/updater/tests.rs` verifies a package signed by
  `tauri signer sign` against the committed pubkey, the same way the plugin
  does. It also checks that tampered bytes, a foreign key, an edited trusted
  comment, and empty or garbage signatures all fail. Other tests cover
  endpoint resolution, https-only endpoints, preference fallbacks, and that
  `tauri.conf.json` matches the crate version and the stable endpoint.
- `scripts/release/update-manifest.mjs` checks each updater artifact in CI
  before it publishes a manifest, using the same minisign rules.
  `tests/unit/release-scripts.test.ts` covers it.
- `tests/integration/updates.test.tsx` covers the Updates tab. It runs the
  channel and auto-check preferences through the real bridge, then checks,
  shows progress, installs, and relaunches. It also covers saving before
  install, cancelling, the error shown for a rejected signature, and the
  start-up check.

## Manifest layout on the release host

```
<bucket>/stable/latest.json
<bucket>/stable/<version>/<updater payloads>
<bucket>/beta/latest.json
<bucket>/beta/<version>/<updater payloads>
```

`latest.json` is uploaded last with `Cache-Control: no-cache`, so it never
points at a payload that is missing.
