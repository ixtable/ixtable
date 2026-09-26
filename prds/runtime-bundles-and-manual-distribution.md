# PRD: Runtime Bundles & Manual Distribution

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Allow free users to export and manually distribute runtime-only application bundles without requiring ixtable Cloud, while preserving installation-local data across definition updates.

## Security boundary

Runtime-only bundles are an application packaging/access-control feature, not DRM.

The MVP threat model assumes an authorized recipient controls their machine and can potentially inspect memory, displayed data, or a modified Apache-licensed client.

The product must not claim that runtime-only packaging protects secrets from a malicious authorized recipient.

## Bundle identity

Every runtime bundle must carry immutable metadata sufficient to distinguish:

- application/document identity;
- exported application version;
- bundle format version;
- minimum compatible Runtime version;
- build/export timestamp;
- embedded RecordStore initialization version;
- ordered application migration set/checksums;
- whether password protection is enabled.

Display names are not identity.

A bundle from application A must never be accepted as an update to installation B solely because names match.

## Bundle contents

A runtime-only bundle contains only what Runtime needs, including:

- application definition;
- required application assets;
- datasource definitions without plaintext protected credentials;
- initial embedded SQLite state when applicable;
- migrations needed for supported upgrades;
- integrity metadata.

Studio-only editor state that is unnecessary for Runtime should be omitted where practical, but removing it must not create a second incompatible application-definition model.

## Runtime-only behavior

Through the official product flow:

- bundle opens in Runtime, not Studio;
- runtime user cannot persist definition edits;
- data/state mutations permitted by the application still work;
- manually distributed bundles require no ixtable account.

Because the desktop core is open source, this is not a promise against modified clients.

## Password protection

Password protection is optional.

Requirements:

- use reviewed, established cryptographic libraries;
- use an approved password KDF with stored parameters/salt;
- use authenticated encryption;
- integrity/authentication is checked before decrypted application content becomes active;
- plaintext password is never stored;
- decrypted temporary material is minimized and cleaned up where practical;
- wrong password and tampering fail closed;
- error behavior does not expose whether partial decrypted content was valid.

Cryptographic algorithm/KDF selection belongs in an ADR/security review, not an ad hoc implementation choice.

## Installation identity

On first launch, a runtime bundle creates/claims an installation identity separate from application identity.

Installation identity scopes:

- embedded SQLite runtime data;
- local async job queue;
- local runtime preferences/state;
- optional future cloud backup stream.

Reopening the same bundle must not reinitialize and overwrite an existing installation's local state.

## SQLite initialization

For embedded SQLite:

1. validate bundle;
2. create installation identity/state directory;
3. initialize the local RecordStore from the bundle's seed database;
4. record the installed application version and applied migration history;
5. activate only after initialization succeeds.

After initialization, the bundle's SQLite copy is not authoritative for that installation's business records.

## Manual update flow

A newer bundle can update an existing installation only when:

- application identity matches;
- bundle/runtime format is compatible;
- version transition is allowed;
- required historical migrations match recorded checksums;
- migration path exists;
- required assets/config validate.

Update sequence:

1. stage new definition/assets separately;
2. snapshot/prepare recovery for installation-local state as required;
3. run preflight;
4. execute required migrations;
5. validate migrated runtime state and definition;
6. atomically switch active application version;
7. retain previous usable version/recovery metadata according to policy.

A failed update must not leave the new version active.

## Rollback

Rollback semantics depend on data migration compatibility.

- Definition-only rollback may activate the previous definition when it remains compatible with current data.
- A data-schema downgrade requires explicit reverse migrations.
- If reverse migration is unavailable, Runtime must explain that rollback of the application definition is unsafe rather than corrupting data.

“Keep prior working version” does not mean blindly downgrading a database after irreversible migrations.

## PostgreSQL bundles

For PostgreSQL-backed applications:

- no database is initialized locally;
- bundle carries datasource definition and credential references only;
- developer owns PostgreSQL schema/data lifecycle;
- runtime validation confirms required schema/migration expectations before activation where feasible.

Manual distribution does not provide remote credential revocation.

## Local credential handling

Where a manually distributed app needs a protected local credential, its storage/unlock mechanism must be separately specified and must not imply cloud-grade revocation.

Password protection of the bundle is not automatically equivalent to secure per-user datasource credential distribution.

## Acceptance criteria

- Recipient can run a valid bundle without Studio or cloud login.
- Official Studio refuses normal editing of runtime-only bundle definitions.
- Wrong password/tampered encrypted bundle fails before activation.
- Two applications with same display name cannot cross-update.
- Reopening/reimporting a bundle does not reset established installation-local SQLite records.
- Definition-only update preserves local records and installation identity.
- Applied migration checksum mismatch blocks update.
- Failed migration/update retains the prior active version and recoverable local data.
- Irreversible migration prevents unsafe rollback with an actionable explanation.
- PostgreSQL runtime bundle never claims its database contents are bundled/backed up.
- Manual distribution still works after ixtable Cloud is unavailable.

## Non-goals

- remote revocation;
- automatic update delivery;
- user fingerprinting;
- centralized audit;
- protection against a malicious authorized recipient;
- SQLite synchronization between installations.
