# PRD: Cloud Backup, Updates & Recovery

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define cloud checkpoint backup/versioning, Runtime update delivery, restoration, and optional per-installation SQLite backup without implying cross-device synchronization.

## Distinct version streams

The product must distinguish:

1. **Developer archive checkpoints** — editable `.ixt` snapshots uploaded/backed up.
2. **Published application versions** — immutable versions eligible for Runtime distribution.
3. **Runtime installation state backups** — optional per-installation SQLite state.

These streams must not be conflated in API/UI/storage naming.

## Developer archive backup

Eligible local `.ixt` checkpoints are stored in versioned object storage.

Each checkpoint records at least:

- cloud application ID;
- source `document_id`;
- checksum/content digest;
- size;
- created/uploaded time;
- application/config/archive versions;
- source device/user where appropriate;
- validation status.

A checkpoint is considered restorable only after upload completes and server-side integrity/metadata validation succeeds.

## Backup upload

Uploads should support resumable/retry-safe behavior appropriate for the 500 MB limit.

Required semantics:

- idempotent finalize;
- incomplete uploads are never shown as valid checkpoints;
- digest mismatch rejects finalization;
- retries do not create ambiguous duplicate versions;
- retention/deletion is plan-aware.

## Restore of developer archive

Restore never rewrites historical checkpoint bytes.

A restore operation either:

- downloads a selected checkpoint for explicit local replacement/fork; or
- creates a new current checkpoint/reference derived from the historical version.

UI must show consequences for newer local/cloud changes.

Restore does not implicitly publish.

## Published Runtime update discovery

Runtime update eligibility depends on:

- authenticated application membership;
- paid entitlement;
- current installed version;
- active published version;
- compatible Runtime version;
- migration path.

Update checks may occur during sync/startup according to product policy, but update activation follows the same staged/atomic model as manual bundles.

## Update staging and activation

1. Fetch published-version metadata.
2. Verify entitlement/member state.
3. Download to staging.
4. Verify checksum/signature/application identity.
5. Validate compatibility and migration history.
6. Prepare local recovery state.
7. Execute required migrations.
8. Validate resulting state.
9. Atomically switch active definition/version.
10. Record successful installation version.

Interruption before step 9 must leave prior active version usable.

## Failure and retry

A failed update records:

- target version;
- stage of failure;
- normalized error;
- whether retry is safe;
- recovery action taken.

Runtime must not enter an automatic crash/update loop retrying a permanently invalid version indefinitely.

A bad published version may be withdrawn from future delivery without mutating historical evidence.

## Rollback

Rollback is constrained by data migrations.

Definition rollback is permitted only when compatible with current installation state.

Data-schema downgrade requires explicit reverse migration.

Automatic rollback after failed activation uses the pre-update recoverable state, not an unsafe logical downgrade after irreversible changes.

## Runtime SQLite installation state

Each installation has a unique installation ID and independent SQLite state.

Cloud backup, when enabled, is keyed by at least:

- cloud application;
- runtime user where relevant;
- installation ID;
- state version/checkpoint ID.

Two installations must never share one mutable backup stream merely because they use the same application/user.

## Runtime SQLite backup contents

An installation checkpoint includes the ixtable-managed state required for consistent recovery:

- embedded business record database;
- managed 
- applied migration history;
- state metadata needed to match compatible application definition.

Local ephemeral caches and downloaded definition assets may be reconstructed and need not be treated as business-state backup.

## No synchronization semantics

Installation backup is snapshot backup/restore only.

It does not:

- merge records;
- reconcile conflicts;
- make two devices current replicas;
- implement collaborative SQLite access.

UI must use “backup/restore” terminology, not “sync records.”

## Runtime restore

Restore to an installation:

- validates application/installation identity;
- checks compatibility with target app definition;
- restores records as one consistent checkpoint;
- does not merge with current state;
- creates recovery protection for the state being replaced.

Cross-installation restore, if ever allowed, must be an explicit clone/import operation, not accidental stream reuse.

## PostgreSQL boundary

ixtable Cloud does not back up developer-managed PostgreSQL records.

Cloud can back up:

- application definition/archive checkpoints;
- published-version metadata;
- ixtable control-plane metadata.

Restore UI must explicitly state that external PostgreSQL data remains the developer's responsibility.

## Recovery UX

Users with appropriate permissions can inspect:

- current application version;
- latest successful update;
- failed update reason;
- developer checkpoint history;
- installation backup history applicable to them;
- restore compatibility;
- consequences of restore/rollback.

## Retention and deletion

Retention policy is plan-aware and documented.

Account/application deletion must coordinate:

- developer archive objects;
- published-version artifacts;
- installation backup objects;
- signing/key metadata that must remain only as required for security/audit/legal reasons.

Deleted backups must not remain restorable through stale object URLs.

## Acceptance criteria

- Interrupted upload never appears as restorable checkpoint.
- Digest mismatch rejects checkpoint finalization.
- Restore does not implicitly publish.
- Interrupted update before activation leaves previous version active.
- Failed update does not enter unbounded auto-retry loop.
- Installation A cannot overwrite/merge installation B's backup stream.
- SQLite restore returns records + migration history to one consistent checkpoint.
- Definition updates do not overwrite runtime-local business state.
- PostgreSQL application restore UI never claims external records were recovered.
- Revoked/deleted entitlement prevents future protected update retrieval.
- Deleted backup object cannot be retrieved using a stale normal application URL/token after deletion policy completes.

## Non-goals

- live SQLite replication;
- conflict resolution/record merging;
- cloud-hosted SQLite execution;
- PostgreSQL database backup service;
- multi-device current-state synchronization.
