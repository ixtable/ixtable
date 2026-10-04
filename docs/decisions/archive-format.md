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

Ordinary tables that this build does not know are copied, with rows and
indexes, from the previous archive of the same document. Views, triggers,
virtual tables, and tables from a different document are never copied.

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

On the next start, a dirty session that never closed is offered for recovery.
Recovery checks `PRAGMA integrity_check` on `data.db`, loads `document.json`,
and verifies every asset checksum. Valid work is checkpointed and saved back
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
- Every released format stays openable. `tests/fixtures/archives/format-<N>/`
  holds one `.ixt` per golden app (CRM, inventory with its asset, work
  orders) with seeded data, plus a `manifest.json` of the ids, row counts, and
  asset checksums each must contain. A change that bumps `FORMAT_VERSION` adds
  a new `format-<N+1>/` with `node scripts/ci/write-archive-fixtures.mjs` and
  never rewrites an existing directory. Each manifest entry records the
  sha256 of its `.ixt`, checked by a Rust test, and the lint job runs
  `scripts/ci/check-archive-fixtures.mjs`, which fails a pull request that
  modifies or deletes a fixture file present on the base branch. `format-1/`
  holds the same documents as `format-2/` in the legacy layout (no
  `application_id`, no `payload_chunks`, config version 2), derived by
  `node scripts/ci/write-archive-fixtures.mjs --format-1`. `.gitattributes`
  marks `*.ixt` binary.

## Evidence

- `src-tauri/src/archive_io/tests.rs`: format 1 upgrade with unknown-table
  preservation, newer and ancient format rejection, large chunked payloads with
  checksum checks, interrupted writes that keep the last valid archive, no
  copying from another document.
- `src-tauri/src/recovery.rs` tests: valid WIP loads with its assets, and
  invalid WIP is reported, not loaded.
- `tests/integration/persistence.test.tsx`: autosave states, autosave failure
  and retry, crash recovery from the start screen, invalid recovered work,
  ignored temp-file leftovers.
- `tests/integration/assets.test.tsx`: asset checksums, archive size report,
  checkpoint create and restore-as-copy.
- `tests/unit/autosave.test.ts`: debounce, max wait, single in-flight save.
- `src-tauri/src/durability_tests/fixtures.rs`: every committed archive
  fixture opens with the current build, matches its manifest (forms, queries,
  reports, dashboards by id, row counts, asset checksums), saves (upgrading
  older formats), and reopens.
- `src-tauri/src/durability_tests/kill.rs`: a real child process saves and
  autosaves a growing document and is killed (`Child::kill`) at eight delays
  and, alternately, while a test-only marker shows an archive write or rename
  is in progress (at least one kill must land mid-write). The archive at the
  path always verifies, and the leftover workspace is recovered into it (saved
  back: not dirty, no error, archive rows equal the workspace's; at least one
  run must grow the archive) or refused with `RECOVERY_FAILED`. The writer is
  killed on drop and stops itself after 512 MB or two minutes.
- `src-tauri/src/durability_tests/heavy.rs` (opt-in): an archive just over
  500,000,000 bytes saves and reopens, the size report flags it, and the
  publish preflight blocks it. Run with
  `IXTABLE_HEAVY_TESTS=1 cargo test --lib durability_tests::heavy` (about a
  minute and 1.5 GB of temporary disk). Default CI does not run it.
