# Runtime-only bundles: signing, password protection, and trust

Status: accepted for local manual distribution. Cloud personalized bundles and
envelope-encrypted credential delivery are out of scope for the desktop work
and need their own record and an external review before implementation. Covers
PRD §4.1, §21.2, §22.3, §27.2, and the Phase 0 runtime-bundle spike.

## Context

A developer can hand a recipient a locked, runtime-only copy of an
application. The recipient runs it without Studio, and later installs updates
by hand. The PRD requires signed bundles that fail closed, optional password
protection, no custom cryptography, and no claim of protection beyond what the
design gives. There is no cloud identity in this flow.

## Decision

### File format

A bundle (`.ixtr`) wraps a complete `.ixt` archive. All integers are
little-endian:

```text
"IXTRBNDL" | u16 format | u32 header_len | header JSON | u64 payload_len | payload | Ed25519 signature (64 bytes)
```

The header holds the bundle id (the document id), name, semver version,
release notes, minimum runtime version, creation time, signer public key,
payload SHA-256, and the encryption parameters when present. The signature
covers every byte before it.

### Primitives

| Purpose | Primitive | Crate |
|---|---|---|
| Signature | Ed25519, verified with `verify_strict` | `ed25519-dalek` 2 |
| Password key derivation | Argon2id, 19 MiB, 2 passes, 1 lane, random salt | `argon2` 0.5 |
| Payload encryption | XChaCha20-Poly1305, random 24-byte nonce, header bytes as associated data | `chacha20poly1305` 0.10 |
| Payload integrity | SHA-256 | `sha2` |

The Argon2id parameters are the OWASP baseline. They are stored in the header,
so a later build can raise them without breaking older bundles. The header is
untrusted until the password checks out, so the Runtime refuses parameters
above 256 MiB, 4 passes, or 4 lanes with `BUNDLE_INCOMPATIBLE`. It also refuses
bundle files larger than 600 MB (`BUNDLE_TOO_LARGE`) before reading them,
because verification happens in memory.

### Keys and trust

Each developer gets one Ed25519 signing key, created on first export at
`<state>/keys/runtime-bundle-signing.key` with mode `0600` on Unix. It is a
local key, not an identity. The Runtime pins the signer of the first bundle
it installs for a bundle id, in `installations/<bundleId>/bundle.json`. A
later bundle for the same id with any other key fails with
`BUNDLE_SIGNER_MISMATCH` and is not opened. This is trust on first use.

### Verification order

1. Check the magic, format version, and header size limit.
2. Verify the Ed25519 signature over the whole file. Any change fails here.
3. Check the encryption flags against the header.
4. Check the signer against the key pinned for this bundle id.
5. Check the semver version and `minRuntimeVersion` against this Runtime.
6. Decrypt when protected. A wrong password fails with `BUNDLE_PASSWORD`.
7. Check the payload SHA-256 before the archive is opened.

### Installations and updates

A Runtime installation lives in `<state>/installations/<bundleId>/`.
`active/app.ixt` holds the definition and `data.db` holds the recipient's
records, which the bundle seeds only on first open. An update stages the new
definition with a copy of the records. It applies pending migrations and
health checks to the copy, then swaps it in. The previous version is kept in
`previous/`, and any failure restores it. An older version installs only when
the user confirms a downgrade.

A manual update or downgrade stops at a confirm step first (PRD §22.3 step 7).
It shows the release notes (line breaks kept) and the migrations that would
run on this installation's records, with their SQL. A downgrade is applied
only from its explicit "Install older version … anyway" button.
`inspect_runtime_bundle` checks Runtime compatibility before reading the
archive, then fills `pendingMigrations` for an unencrypted bundle. The preview
is best effort: if it fails, inspect still succeeds with
`migrationsUnavailable` set to the reason, and the confirm step says so. A
protected bundle needs its password first, so the UI calls
`preview_runtime_update(path, password)` after the password prompt. Both read
`data.db` read-only: the ids in `_ixtable_migrations` are compared with the
incoming definition's supported migrations.

Inspect returns the file's `sha256`. The file flow passes it back as
`expectedSha256` (required by `update_runtime_installation`, optional for
`open_runtime_bundle`), and Rust refuses a file whose hash changed since
inspection (`BUNDLE_CHANGED`), so the applied bundle is the one confirmed.

`bundle.json` records what the last apply did: `lastAction` (`install`,
`open`, `update`, `downgrade`) and `appliedMigrations`, the names of the
migrations that ran (empty for a fresh install and for opening the installed
version). Cloud auto-sync shows the post-update notice only when `lastAction`
is `update` or `downgrade`.

Studio and installation updates share one migration preflight
(`migrations::preflight`). Before any SQL runs it rejects an applied migration
whose `up` SQL changed (checksum) and any `depends_on` that is unknown, unapplied,
or ordered after its dependent, so a bad update fails and activation is blocked.
The migration log records real start and finish times and the health-check
outcome; the preview splits statements with SQLite's own completeness rules.
After Studio applies or rolls back migrations it re-validates the document so
forms and queries bound to dropped columns surface as problems at once.

A `bundle.json` that exists but cannot be read or parsed fails with
`INSTALLATION_CORRUPT`. It is never treated as "not installed", because that
would drop the pinned signer. An installation folder with no `bundle.json` at
all is moved aside to `<bundleId>.corrupt-<timestamp>` before a fresh install,
never deleted.

### Runtime window

A runtime-only window shows the application, not Studio. Its title is the
application name. It has no ribbon (view switch, undo, redo), no mode switch,
no Save buttons, no `PROJECT /` breadcrumb, and no "Preview as role" switch.
A manual bundle runs with full access, because the document config has no
default runtime role. A cloud installation runs as the role in its signed
manifest and shows it as `Role: <name>`. The role lives in the Rust session
(`authz.rs`) and is checked at each record command, so a direct `invoke`
gets `FORBIDDEN` just like the UI. Studio's "Preview as role" sets the same
Rust role while Run mode shows, so a preview behaves like the installed
runtime; leaving Run mode ends it. Runtime sessions keep the ids the
bundle was published with; only Studio rewrites the legacy `main` form id
(`design/upgrade.rs`, `rekey_legacy_ids`).

### Database login

A manual bundle on PostgreSQL carries no password, so the recipient enters a
database login. When the bundle opens, `DatabaseLogin` asks
`runtime_datasource_login_status`. It opens the "Database login" dialog when
no login is stored (`missing`) or the server refused the stored one
(`rejected`, from the reader's attach error). The username starts as the
datasource's user and may be changed. `set_runtime_datasource_login` checks
the username, requires a confirmed transport, and connects (`postgres::probe`)
before storing anything; a refusal comes back as `AUTH_FAILED` (SQLSTATE class
28) with a redacted message. A verified login goes to the local secret store
under `installation:<bundleId>:datasource:<datasourceId>`, sealed and bound to
the datasource target. The reader then re-attaches. "Database login…" in the
runtime sidebar re-enters the login or forgets it
(`clear_runtime_datasource_login`).

The installation id reaches the credential lookup through
`DatasourceConfig.installation`, a `serde(skip)` field set only by
`open_runtime_session`, so Studio and other installations never see the
login. `secrets::datasource_login` picks a login in this order: a cloud key
grant, the installation's login, then the developer's `passwordRef`. An update
that moves the datasource to another host, port, database, or user changes the
target, so the stored login no longer matches and Runtime asks again. Cloud
installations get their login from key grants and never show the dialog.

The runtime sidebar has a "Diagnostics…" button for the background job queue
(status, attempts, retry, cancel; the Studio `JobsPanel`) and the local log
(`LogsTab`). Neither changes the definition.

## Threat model limits

The release tab shows the first limit next to the password option, in the
words of PRD §4.1.

- A password protects the bundle at rest and against casual opening. Anyone
  with the password can open it, read every record it shows, and extract the
  archive.
- The password protects the distributed `.ixtr` file only. Once installed,
  `installations/<bundleId>/active/app.ixt` and `data.db` are plaintext at
  rest, protected only by the user account's file permissions. During
  install, the decrypted archive touches disk only as a `0600` scratch file
  that is deleted as soon as it has been read.
- Trust on first use does not protect the first install. A recipient must get
  the first bundle, or the signer fingerprint, from the developer over a
  channel they trust.
- A lost signing key cannot be rotated for existing installations. They must
  reinstall from a bundle signed by the new key.
- The signing key file is protected only by file permissions. Malware running
  as the developer can sign bundles.
- Bundles carry no PostgreSQL password. `DatasourceConfig` stores only
  `passwordRef`, and the secret stays in the developer's local secret store.
  Recipients enter their own login in Runtime. It is sealed in their local
  secret store under the machine key, which the OS account's file
  permissions protect. Anyone who can read that account's files can open it.
- A fork of the Apache-2.0 desktop code can remove any of these checks for
  its own users. The checks protect honest Runtimes from tampered files.

## Consequences

- No account or network is needed to export, verify, or update a bundle.
- Verification fails closed before any archive byte is parsed.
- Cloud distribution will need per-user personalization, key grants, and
  revocation (PRD §21.3). This format leaves room through the format version
  and header fields, but none of that is built.

## Evidence

- `src-tauri/src/bundle/tests.rs`: signed round trip, password round trip and
  wrong password, tampering fails the signature, runtime version rules, and a
  persistent private signing key.
- `src-tauri/src/installation/tests.rs`: first open seeds data and pins the
  signer, updates keep installation records, downgrade needs confirmation, a
  different signer is rejected, migrations on update, a failing migration or
  health check reverts, restore of the previous version, reset, and unsafe
  bundle ids.
- `src-tauri/src/recordstore/runtime_login_tests.rs`: logins sealed per
  installation and target, precedence (grant, installation, Studio), a moved
  datasource asks again, username validation, auth failures told apart from
  unreachable servers, and `AUTH_FAILED` from a real PostgreSQL server.
- `tests/integration/runtime-database-login.test.tsx`: the prompt opens for a
  PostgreSQL bundle with no login; an unverifiable login is not stored; with
  `IXTABLE_TEST_POSTGRES_URL` a wrong password is refused, the right one
  connects and reads, and "Forget saved login" asks again.
- `tests/integration/bundle.test.tsx`: export from Studio, open runtime-only
  without Studio chrome, update while keeping records, password prompt, and a tampered bundle
  rejected before opening.
