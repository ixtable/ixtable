# PRD: Cloud Backup, Updates & Recovery

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define cloud archive backup/versioning, runtime update delivery, restore, and optional per-installation SQLite backup without implying cross-user record synchronization.

## Archive backup

- Published/eligible `.ixt` checkpoints are stored in S3-backed versioned storage.
- Archive validation occurs before accepting a checkpoint as restorable.
- Retention and deletion rules are plan-aware.
- Restore creates or selects a recoverable checkpoint; it does not mutate historical objects in place.

## Runtime application updates

- Runtime checks for entitled published versions during sync.
- Download verifies identity, entitlement, integrity, and signature.
- Definition update activates atomically.
- Required migrations complete before new version becomes active.
- Failure reverts to the previous working version.

## SQLite runtime state

Each runtime installation has independent SQLite record state after initialization.

Optional cloud backup:

- is per installation;
- never merges two installations;
- preserves record attachments;
- is explicitly labeled backup/restore, not synchronization.

## PostgreSQL

Cloud backup does not represent developer-managed PostgreSQL records as backed up.

Restoring an app definition may restore schema/config/migration state, but external PostgreSQL backup/restore remains the developer's responsibility.

## Recovery UX

Developer/runtime user can see:

- current app version;
- backup/checkpoint history available to them;
- update state;
- failed migration/update reason;
- restore eligibility and consequences.

## Acceptance criteria

- Interrupted update retains prior working version.
- SQLite installation A cannot overwrite/merge installation B's backup stream.
- Restoring a definition checkpoint does not falsely claim PostgreSQL data recovery.
- Record attachments are included in eligible SQLite installation backup.
- Deleted/revoked entitlement prevents future update retrieval.

## Non-goals

- live SQLite replication;
- conflict resolution;
- cloud-hosted SQLite execution;
- PostgreSQL database backup service.
