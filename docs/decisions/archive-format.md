# `.ixt` archive format, atomic writes, and crash recovery

Status: accepted. Covers PRD §7, §27.1, and the Phase 0 archive and atomic
checkpoint spikes.

## Context

An ixtable application is one `.ixt` file that holds the definition, the
embedded SQLite records, and application assets. It must survive crashes,
power loss, and interrupted writes without losing the last good save. It must
also open files written by older builds, and keep data written by newer ones.

A zip of loose files would need a custom writer for atomic updates and would
hold every payload in memory. SQLite already gives transactions, checksummed
pages, and a schema that later builds can extend.

## Decision

The archive is a SQLite database in the spirit of
[SQLite Archive](https://sqlite.org/sqlar.html), with `PRAGMA application_id`
set to `ixtb`. Format 2 has these tables:

| Table | Contents |
|---|---|
| `archive_metadata` | format version, document id, timestamps, app version |
| `data_payload` | zstd-compressed `data.db` with SHA-256 and uncompressed size |
| `document_config` | `DocumentConfig` JSON and its config version |
| `attachments` | application assets with media type, checksum, and size |
| `payload_chunks` | continuation chunks for payloads over 4 MiB |

Payloads stream through zstd in 4 MiB chunks. No payload sits in memory whole,
and none hits SQLite's 1 GB blob limit. Format 1 archives open unchanged and
are rewritten as format 2 on the next save. A newer format fails with a message
that asks the user to update ixtable.

`DocumentConfig.version` is checked the same way. Older configs upgrade on
load. A newer config version fails with `UNSUPPORTED_VERSION` and a message
that asks the user to update ixtable, not with `INVALID_ARCHIVE`. Top-level
config fields this build does not know (a newer build with the same config
version) are kept in `DocumentConfig.extra` and written back unchanged by
saves, `document.json`, and the `config.yaml` projection.

Ordinary tables that this build does not know are copied, with rows and
indexes, from the previous archive of the same document. Views, triggers,
virtual tables, and tables from a different document are never copied. The
one exception is Restore as copy: the new archive gets a new document id but
deliberately copies the checkpoint, so it keeps the checkpoint's unknown
tables too.

### Save path

`archive_io::write` writes a complete archive to a hidden temp sibling
(`.<name>.<uuid>.tmp`), calls `fsync`, and reopens it to verify every checksum.
Only then does it rename the temp file over the destination and sync the
parent directory. Any failure removes the temp file and leaves the old archive
in place. Leftover temp files from a killed process are never read and are
removed on the next successful save.

Before saving, the manager compares the file's fingerprint with the one it
recorded at open. A file changed by another program blocks the save with
`EXTERNAL_CONFLICT` until the user reloads or uses Save As.

### Working session and recovery

Opening a document extracts it to `recovery/<sessionId>/`: `data.db`,
`document.json`, `config.yaml`, `archive.json`, and
`attachments/<id>/{content,metadata.json}`. Record writes go to that `data.db`.
The global store registers each session with a `dirty` flag.

The JSON and YAML files in the workspace are each written atomically: a hidden
temp sibling, `fsync`, rename, then a directory sync. A crash leaves the old
or the new file, never a truncated one. `document.json` and `config.yaml`
hold the same config, so recovery reads `document.json` and falls back to
`config.yaml` when it is missing or unreadable.

On the next start, a dirty session that never closed is offered for recovery.
Recovery checks `PRAGMA integrity_check` on `data.db`, loads the config, and
verifies every asset checksum. It opens `data.db` read-write (never creating
it): a crash in the middle of a transaction leaves a hot rollback journal, and
only a writable connection can roll it back. A read-only open fails with
`SQLITE_READONLY_ROLLBACK` and would reject work that is recoverable. Rolling
back drops only the uncommitted transaction, which is the correct crash
outcome. Valid work is checkpointed and saved back
into the `.ixt`. Invalid work never touches the archive, and the error is
shown instead.

The frontend autosaves 1.5 s after the last change, and at most 10 s after the
first unsaved one. It shows dirty, saving, saved, and error states. Local
checkpoints are validated archive copies under
`<state>/data/checkpoints/<documentId>/`, and the newest 20 are kept.

## Consequences

- A crash during a save cannot corrupt the last valid archive. Rename is
  atomic on all three platforms when source and target share a directory.
- Any SQLite tool can inspect an archive. Editing one by hand changes its
  fingerprint and triggers the conflict check.
- A save rewrites the whole file. Save time grows with archive size, which the
  500 MB cloud limit bounds.
- Unknown-table preservation only works for plain tables. A future format
  that needs views or triggers must bump `FORMAT_VERSION`.

## Evidence

- `src-tauri/src/archive_io/tests.rs`: format 1 upgrade with unknown-table
  preservation, newer and ancient format rejection, large chunked payloads with
  checksum checks, interrupted writes that keep the last valid archive, no
  copying from another document.
- `src-tauri/src/recovery.rs` tests: valid WIP loads with its assets,
  invalid WIP is reported, not loaded, a truncated or missing `document.json`
  falls back to `config.yaml`, config files leave no temp files, and a hot
  journal left by a crash is rolled back instead of rejected.
- `src-tauri/src/archive.rs` tests: a newer config version is
  `UNSUPPORTED_VERSION`, and unknown top-level config fields survive save,
  reopen, and the YAML round trip.
- `src-tauri/src/checkpoints.rs` tests: Restore as copy keeps unknown tables.
- `tests/integration/persistence.test.tsx`: autosave states, autosave failure
  and retry, crash recovery from the start screen, invalid recovered work,
  ignored temp-file leftovers.
- `tests/integration/assets.test.tsx`: asset checksums, archive size report,
  checkpoint create and restore-as-copy.
- `tests/unit/autosave.test.ts`: debounce, max wait, single in-flight save.
