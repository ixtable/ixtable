# DuckDB read path and pinned extensions

Status: accepted on Linux. macOS and Windows are wired into CI
(`.github/workflows/desktop.yml`) and become proven when that matrix passes.
Covers PRD §9.4, §10, and the Phase 0 DuckDB spikes.

## Context

The PRD splits reads from writes. Every list, detail, selector, saved query,
report, and dashboard dataset reads through DuckDB. Every create, update, and
delete goes straight to the RecordStore. DuckDB reaches SQLite and PostgreSQL
through loadable extensions, and those must be a fixed, verified set on all
three platforms. Arbitrary extension installation is deferred.

## Decision

### One reader per session

`data::ReadRuntime` owns an in-memory DuckDB connection per open document. It
attaches the datasource as the `data` catalog in `READ_ONLY` mode. For SQLite
that is `<workspace>/data.db` through `sqlite_scanner`. For PostgreSQL it is
the configured schema through `postgres_scanner`, with the password redacted
from any error text.

After every write, the manager calls `mark_data_dirty`, which runs
`ReadRuntime::refresh`. Refresh detaches and reattaches `data`, so the next
read sees committed rows and DDL. Because writes commit before the refresh
returns, a workflow that writes and then reads gets its own write back.

User SQL passes `read_only_guard` first. It allows one statement and rejects
writes, DDL, `ATTACH`, `INSTALL`, `LOAD`, `COPY`, `PRAGMA`, `SET`, and file or
scanner table functions such as `read_csv` and `postgres_query`. Saved queries
use `$name` placeholders. `queries::params` rewrites them to DuckDB
parameters and binds the values, so values are never spliced into SQL text.

### Pinned extensions

- `duckdb` is pinned to `=1.10505.0` with the `bundled` feature, which embeds
  DuckDB 1.5.5. Extensions are ABI-specific, so the crate version and the
  extension version move together.
- `scripts/prepare-duckdb-artifacts.sh <linux-x64|macos-universal|windows-x64>`
  downloads `sqlite_scanner` and `postgres_scanner` v1.5.5 from
  `extensions.duckdb.org`. It checks each `.gz` against a pinned SHA-256 and
  writes `src-tauri/resources/duckdb/<platform>/`. The binaries are
  gitignored, and `resources/duckdb/manifest.json` records both hashes.
- At startup, `manager::sqlite_extension_path` and
  `data::postgres_extension_path` check the uncompressed SHA-256 again before
  `LOAD`. A mismatch fails with `EXTENSION_STARTUP` and the app does not read.
- Autoload and autoinstall are off. DuckDB's own extension signature check
  stays on, because nothing sets `allow_unsigned_extensions`.
- `IXTABLE_DUCKDB_SQLITE_EXTENSION` and `IXTABLE_DUCKDB_POSTGRES_EXTENSION`
  move the lookup to another path. They do not change the pinned hash.
- `tauri.conf.json` bundles `resources/duckdb/**` with the app. The macOS
  build fetches both `arm64` and `x64` builds for a universal app.

The DuckDB extensions on Linux and Windows link DuckDB statically, so they do
not import symbols from the host. `build.rs` still exports dynamic symbols on
Linux for extensions that do.

## Consequences

- Reads cannot write. Writes cannot skip the RecordStore and its
  capabilities, constraint mapping, and concurrency checks.
- Reattaching after each write is simple and correct. It costs one detach and
  attach per write, which is cheap for a local file and a network round trip
  for PostgreSQL.
- Upgrading DuckDB means a new crate pin, new extension hashes in three places
  (script, manifest, Rust constants), and a CI run on all three OSes.
- Offline builds need the extension files fetched once. CI caches them by the
  script's hash.

## Evidence

- `src-tauri/src/data/tests.rs`: autoload is rejected, values convert
  losslessly to canonical forms, `read_only_guard` rejects writes and scanner
  functions.
- `src-tauri/src/recordstore/conformance.rs`: every scenario reads through
  DuckDB after writing through the store, on SQLite and on PostgreSQL when
  `IXTABLE_TEST_POSTGRES_URL` is set (the `postgres` CI job).
- `src-tauri/src/queries/tests.rs`: named placeholders rewritten outside
  literals, typed binding, injection attempts bound, mutating SQL rejected,
  cancellation.
- `tests/integration/sql-and-metadata.test.tsx` and
  `tests/integration/query-mode.test.tsx`: read SQL, write rejection,
  parameters, and cancel through the UI and the real bridge.
- [RecordStore and DuckDB type matrix](./recordstore-type-matrix.md).
