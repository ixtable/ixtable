# PRD: Application Archive & Lifecycle

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Define the lifecycle of a local ixtable application, including creation, open, extraction, autosave, checkpointing, recovery, migration, and compatibility of the `.ixt` SQLite Archive.

## Scope

The `.ixt` file is the durable application container and source of truth after a successful save. Working-session extraction exists only to support normal files and database connections while the application is open.

The archive must preserve:

- application metadata and format version;
- `DocumentConfig`;
- embedded SQLite RecordStore payload;
- application asset attachments;
- future unknown archive tables where safe; and
- application version metadata required by runtime distribution.

## Required behavior

### Archive format

- Use SQLite Archive semantics, not ZIP.
- Preserve the existing archive schema and evolve it via explicit format migrations.
- Reject unsupported future `format_version` values with an actionable compatibility error.
- Keep stable document identity across saves and upgrades.
- Validate checksums/structure before a rewritten archive becomes authoritative.

### Working session

On open, ixtable extracts required objects into an isolated working directory. The working directory is disposable WIP, never a second published copy.

Required working files include:

- embedded record store;
- structured config projection;
- YAML projection; and
- extracted application assets.

### Saving

- Autosave is debounced.
- Archive replacement is atomic: write temporary archive, validate, then rename/replace.
- UI exposes dirty, saving, saved, recovery-needed, and save-error states.
- No acknowledged save may disappear after a normal restart.
- Application definition and embedded record data must checkpoint consistently.

### Recovery

- Detect abandoned working sessions after crash/forced termination.
- Offer deterministic recovery when WIP is newer than the last valid archive.
- Never overwrite the last known-good archive with invalid recovered state.
- Preserve evidence/logs when recovery fails.

### Compatibility and migrations

- Archive migrations are versioned and deterministic.
- Upgrades create a recoverable checkpoint before destructive migration.
- Downgrades are supported only where an explicit reverse migration exists.
- Unknown future archive tables/rows are preserved when safe rather than silently discarded.

### Size and performance

- Cloud-synchronized archives are limited to 500 MB in MVP.
- Studio reports total archive size and largest entries before publish/backup.
- Large attachments must not cause partial archive corruption.

## Acceptance criteria

- Create → save → close → reopen round-trips all application definitions and embedded data.
- Forced termination during archive rewrite preserves the previous valid checkpoint.
- Recovery restores valid WIP without mutating the previous checkpoint until validation succeeds.
- Unsupported format versions fail cleanly.
- 500 MB boundary behavior is tested.
- Fixtures cover upgrade and supported downgrade paths on Windows, macOS, and Linux.

## Non-goals

- semantic Git storage;
- collaborative merging of archive contents;
- row-level SQLite synchronization;
- browser-native archive editing.
