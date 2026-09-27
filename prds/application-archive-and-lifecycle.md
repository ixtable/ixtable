# PRD: Application Archive & Lifecycle

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define the lifecycle of a local ixtable application, including creation, open, extraction, autosave, checkpointing, external-file conflict handling, crash recovery, migration, and compatibility of the `.ixt` SQLite Archive.

## Terminology and version domains

These versions are distinct and must not be conflated:

- **Archive format version**: physical `.ixt` SQLite schema compatibility.
- **DocumentConfig version**: canonical application-definition schema compatibility.
- **Design schema version**: serialized form/layout object compatibility.
- **Application version**: version of the application being authored/distributed.
- **Desktop product version**: version of ixtable itself.

Each domain must have independent validation and migration rules.

## Source-of-truth model

The `.ixt` file is the durable application container and source of truth after a successful save. A working session is mutable WIP extracted from that checkpoint.

Current archive tables are:

- `archive_metadata`
- `data_payload`
- `document_config`
- `attachments`

Current working-session files are:

- `data.db`
- `document.json`
- `config.yaml`
- `attachments/<stable-id>/content`
- `attachments/<stable-id>/metadata.json`

These names are part of the MVP compatibility contract unless deliberately migrated.

## Archive format

- Use SQLite Archive semantics, not ZIP.
- Extend the existing archive schema; do not introduce a second bundle format for editable applications.
- `archive_metadata` contains exactly one logical archive identity, including stable `document_id`.
- `data_payload` contains the compressed embedded SQLite RecordStore checkpoint.
- `document_config` contains the canonical JSON application definition.
- `attachments` contains application-definition assets, not runtime record attachments.
- Payloads with checksums must verify checksum and uncompressed size on read.
- Unknown future tables/rows are preserved byte-for-byte where technically possible when the overall archive version is otherwise supported.
- Unsupported future archive format versions fail before extraction or mutation.

## Working-session storage

Working sessions live in a persistent ixtable app-data recovery directory, keyed by session ID/document ID rather than beside the source `.ixt` file. This supports crash recovery, multiple application sessions, diagnostics, and controlled cleanup without polluting user project directories.

Only one read/write Studio session for the same authoritative `.ixt` is allowed in the same ixtable process in MVP. A second open is blocked rather than creating competing writers.

Unsaved applications still receive a durable recovery workspace before first Save As. This workspace is recovery WIP only; it is not a hidden authoritative `.ixt` file.

## Session lifecycle

### Create

A new unsaved application:

- receives a new stable `document_id`;
- creates a valid empty embedded SQLite database;
- creates the current default `DocumentConfig`;
- has no authoritative filesystem path until Save As succeeds;
- is dirty only after user-visible modification.

### Open

Opening an archive must:

1. open the source archive read-only;
2. validate archive version and required singleton rows;
3. verify compressed payload checksums/sizes;
4. validate `DocumentConfig` and design schema;
5. extract into an isolated recovery workspace;
6. start the DuckDB read runtime against the extracted store;
7. register a recovery-session record;
8. fingerprint the source file for later external-conflict detection.

Failure before step 7 must not create an apparently valid open session.

### Save / Save As

Before packing:

- `data.db` from the workspace is the current embedded SQLite WIP and must replace the in-memory payload;
- `DocumentConfig`, YAML projection, and application assets must represent one consistent definition state.

Archive replacement must be atomic:

1. write a temporary SQLite archive in the destination directory;
2. commit all archive rows;
3. flush/sync the temporary file;
4. reopen and fully validate the temporary archive;
5. atomically replace/rename into the destination;
6. sync the parent directory where supported.

A failed save leaves the previous authoritative archive untouched.

### Autosave

For a saved application, autosave is eligible only when:

- the session is dirty;
- a destination path exists;
- no external conflict is active;
- another save is not active; and
- the autosave debounce/interval has elapsed.

The MVP uses a **60-second autosave interval with debounce/coalescing**. Changes made during the interval are coalesced; once the interval is eligible, autosave waits for a short quiet period so bursts of edits produce one archive rewrite rather than repeated rewrites. Autosave must not rewrite the archive more frequently than the 60-second interval unless the user explicitly invokes Save.

Unsaved applications require Save As and are never silently assigned a path.

## External file conflicts

ixtable must detect when the authoritative `.ixt` file changed outside the current session.

The source fingerprint uses filesystem modification state + file size + archive `document_id` identity validation. Full-file hashing is not required for routine external-change detection.

When an external change is detected:

- autosave stops;
- normal overwrite-save is blocked;
- the session enters explicit conflict state;
- the user may Reload or Save As; direct overwrite of the externally changed path is not offered in MVP;
- ixtable must not silently merge two archive versions in MVP.

Reload discards local WIP only after normal dirty/conflict protections are satisfied by the calling UX.

## Recovery

Every open session registers:

- session ID;
- document ID;
- workspace path;
- source document path when one exists;
- last recovery update time.

Recovery workspaces survive abnormal process termination.

On next startup, ixtable must:

- ignore recovery records whose workspace no longer exists;
- identify valid abandoned sessions;
- distinguish the last valid archive checkpoint from newer WIP;
- validate recovered config and embedded data before creating a new archive checkpoint;
- never overwrite the last known-good archive until recovered state validates.

Normal close removes the workspace and its recovery registration only after close is allowed.

## Corrupt application-asset handling

If application config/data remain valid but one application asset is corrupt, ixtable opens the app in degraded mode, marks the broken asset explicitly, and blocks only behaviors that require that asset. It must not silently discard the corrupt asset or make the entire business application inaccessible solely because one non-critical asset is damaged.

## Archive and config migrations

- Archive format migrations and config migrations are separate operations.
- Opening an older supported archive is non-destructive: ixtable migrates into the working representation, but persistence of the upgraded archive format occurs only on explicit/automatic Save.
- A migration must declare source version(s), target version, and whether reverse migration exists.
- Destructive migration creates or preserves a recoverable pre-migration checkpoint.
- Unsupported downgrade fails before source mutation.
- Migration code must be deterministic and fixture-tested.
- Application/schema migrations for user RecordStores are not archive-format migrations; see [RecordStores & Schema](./recordstores-and-schema.md).

## Size and performance

- Cloud-synchronized archives are limited to **500 MB** in MVP.
- Studio reports total archive size and largest entries before publish/backup.
- Over-limit archives remain usable locally.
- Large application assets must not cause partial archive corruption.
- Save operations should expose progress when packing/checkpointing becomes perceptible.
- MVP compression uses fixed deterministic zstd settings rather than adaptive per-payload heuristics.

## Required error classes

Implementations may refine names, but callers must be able to distinguish at least:

- missing source file;
- unsupported archive version;
- invalid archive schema/config;
- corrupt payload/checksum failure;
- external conflict;
- Save As required;
- I/O failure.

## Acceptance criteria

- Create → Save As → close → reopen round-trips application config, embedded records, metadata, and assets.
- Forced termination before archive replacement preserves the previous valid checkpoint.
- Temporary archives are never treated as authoritative before full validation.
- A changed source file blocks overwrite/autosave and exposes explicit conflict state.
- Recovery restores valid WIP without mutating the previous checkpoint until validation succeeds.
- Unsupported archive versions fail before extraction.
- Corrupt `data_payload` or application assets fail checksum/size validation.
- 500 MB cloud boundary behavior is tested without making local open/save illegal.
- Upgrade and supported downgrade fixtures run on Windows, macOS, and Linux.

## Non-goals

- semantic Git storage;
- collaborative archive merging;
- row-level SQLite synchronization;
- browser-native archive editing;
- automatic conflict reconciliation.
