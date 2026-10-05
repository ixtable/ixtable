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

App SQL never runs with external access. The reader opens DuckDB with external
access on only to load the bundled extensions and attach `data`, then runs
`SET allowed_paths=['<workspace>/data.db']`, `SET enable_external_access=false`
and `SET lock_configuration=true`. After that DuckDB itself refuses
`read_csv`, `read_text`, `glob`, file replacement scans (`FROM '/etc/passwd'`),
`COPY TO`, `ATTACH`, `INSTALL`, and loading new extensions, and no `SET` can
undo the lock. Attached databases keep working. The lock is applied even when
the attach fails. The reader then remembers the error, and every read fails
with `Datasource unavailable: ...` instead of falling back to the embedded
file.

After every write, the manager calls `mark_data_dirty`, which runs
`ReadRuntime::refresh`. For SQLite, refresh detaches and reattaches `data`
in place (the file is in `allowed_paths`). DuckDB refuses a PostgreSQL
`ATTACH` once external access is off, so a PostgreSQL refresh, a datasource
switch, or a retry after a failed attach builds a fresh locked database
instead. Either way the next read sees committed rows and DDL. Because writes
commit before the refresh returns, a workflow that writes and then reads gets
its own write back. Config edits re-attach only when `datasource` changed, and
build the new reader outside the sessions lock.

### Writes and reads of one file never overlap

rusqlite and `sqlite_scanner` each link their own SQLite. SQLite coordinates
connections with `fcntl` advisory locks, which belong to the process, so one
copy cannot see the locks the other holds. Picture a DuckDB read that starts
while a RecordStore transaction is open. It finds the writer's rollback
journal, sees no lock on it, and takes it for a crashed writer's hot journal.
Since `data` is attached `READ_ONLY`, it fails with
`attempt to write a readonly database`. Some hosts export their own SQLite
symbols: the `cargo test` binary, and the Linux app because of `build.rs`.
There the extension binds to rusqlite's copy instead. The writer and the
scanner's several handles can then deadlock on SQLite's locks until both fail
with `database is locked`.

`data::gate` arbitrates in process, per file. A RecordStore connection holds
the gate exclusively for its whole life. Every `ReadRuntime` read and every
connection from `DocumentManager::read_connection` holds it shared. The
SQLite refresh after a write holds it exclusively too, because it detaches the
`data` catalog that cloned query connections are using. Waiting writers block
new readers, a thread that already holds the gate passes through, and a wait
longer than 30 seconds fails with `BUSY`. The order stays write, commit,
refresh, read, so read-your-writes holds. An ad-hoc read error is `READ_ONLY`
only when `read_only_guard` rejected the SQL.

User SQL also passes `read_only_guard`, as defense in depth. It ignores string
literals, quoted identifiers, and comments (`data::sqltext::mask`), allows one
statement with an optional trailing `;` that starts with `SELECT`, `WITH`,
`VALUES`, `SHOW`, or `DESCRIBE`, and rejects writes, DDL, `ATTACH`,
`INSTALL`, `LOAD`, `COPY`, `PRAGMA`, `SET`, and file or scanner table
functions such as `read_csv_auto`, any `read_*(...)` or `*_scan(...)` call,
`postgres_query`, and `duckdb_databases` (which would show the PostgreSQL
connection string). Saved queries
use `$name` placeholders. `queries::params` rewrites them to DuckDB
parameters and binds the values, so values are never spliced into SQL text.

Forms whose source is a saved query page through `run_saved_query_page`
(`queries::page`). Like `run_saved_query`, it first checks that a runtime role
may read the query (`authz::check`). The saved SQL runs as a subquery
(`SELECT * FROM (<sql>) AS ixt_page`), and the filters, sort, `LIMIT`/`OFFSET`
wrap it in DuckDB, and a `count(*) OVER ()` column returns the exact total with
the page, so the saved query runs once per page (a separate count runs only
for an empty page past the first). There is no row cap, and the total counts
every matching row. Sort and filter columns must be result columns of the
query and are quoted; an unknown name is reported after a `LIMIT 0` probe.
An `in` filter binds each candidate (`col IN ($n, …)`) and an empty list
matches nothing, as on table pages.
Text search on tables and saved queries is the same case-insensitive `ILIKE`,
with `\`, `%` and `_` in the typed text escaped so they match literally. Filter values, limit and offset bind as
further positional parameters after the query's own, so the same guard and
binding rules apply. Without a sort, the order is whatever the saved query
produces. The form binds each query parameter to an expression over `app` and
the page `params`, which TypeScript evaluates (`sourceParams` in
`src/runtime/data.ts`).

### Pinned extensions

- `duckdb` is pinned to `=1.10505.0` with the `bundled` feature, which embeds
  DuckDB 1.5.5. Extensions are ABI-specific, so the crate version and the
  extension version move together.
- `scripts/prepare-duckdb-artifacts.sh <linux-x64|macos-universal|windows-x64>`
  downloads `sqlite_scanner` and `postgres_scanner` v1.5.5 from
  `extensions.duckdb.org`. It checks each `.gz` against a pinned SHA-256 and
  writes `src-tauri/resources/duckdb/<platform>/`: the archive as downloaded
  and an unpacked copy for dev builds and tests. The binaries are gitignored.
  `resources/duckdb/manifest.json` records both hashes, and the Rust code
  compiles it in (`data::extensions`), so it is the single runtime pin.
- App bundles carry only the archives (`bundle.resources` is
  `resources/duckdb/*/*.duckdb_extension.gz`). On macOS that keeps the
  extensions' ad-hoc-signed Mach-O out of notarization, which rejects it.
  Re-signing them is not an option: it would change their hashes and break
  DuckDB's own signature check.
- `data::sqlite_extension_path` and `data::postgres_extension_path` resolve
  the file before every `LOAD`. They take an unpacked copy in a resource
  directory if there is one (dev) and check its uncompressed SHA-256.
  Otherwise they check the archive's compressed SHA-256, unpack it, check the
  uncompressed SHA-256, and write it to
  `<state>/duckdb-extensions/<uncompressed sha>/<name>.duckdb_extension`.
  The directories are 0700 and the file 0600. The write goes to a unique temp
  file that is renamed into place, so concurrent processes never see a
  partial file. A cached file is reused while its hash matches and replaced
  when it does not. Any mismatch fails with `EXTENSION_STARTUP` and the app
  does not read.
- Autoload and autoinstall are off. DuckDB's own extension signature check
  stays on, because nothing sets `allow_unsigned_extensions`.
- `IXTABLE_DUCKDB_SQLITE_EXTENSION` and `IXTABLE_DUCKDB_POSTGRES_EXTENSION`
  point at an unpacked file elsewhere. They do not change the pinned hash.
- The macOS build bundles both `arm64` and `x64` archives for a universal
  app.

The DuckDB extensions on Linux and Windows link DuckDB statically, so they do
not import symbols from the host. `build.rs` still exports dynamic symbols on
Linux for extensions that do.

## Consequences

- Reads cannot write. Writes cannot skip the RecordStore and its
  capabilities, constraint mapping, and concurrency checks.
- Reattaching after each write is simple and correct. It costs one detach and
  attach per write, which is cheap for a local file and a network round trip
  for PostgreSQL.
- Upgrading DuckDB means a new crate pin, new extension hashes in two places
  (script and manifest), and a CI run on all three OSes. Unpacked copies of
  old versions stay in the state directory under their old hash.
- The first read after install unpacks about 75 MB per platform into the
  state directory. Later starts only hash the cached file.
- Offline builds need the extension files fetched once. CI caches them by the
  script's hash.

## Evidence

- `src-tauri/src/data/extensions_tests.rs`: an archive is verified, unpacked
  0600 into 0700 directories, and reused; a tampered archive (either hash) is
  rejected; a tampered cache file is replaced; eight concurrent unpacks agree
  and leave no temp files; override paths are still verified; every platform
  has both pins in the manifest; an unpacked dev copy is preferred and still
  verified; the official archive for the host platform
  unpacks to a file DuckDB loads.
- `src-tauri/src/data/tests.rs`: autoload is rejected, values convert
  losslessly to canonical forms, `read_only_guard` rejects writes and scanner
  functions but accepts keywords inside literals and identifiers, and file
  reads, replacement scans, `COPY TO`, `ATTACH`, `INSTALL`/`LOAD`, `glob` and
  `SET` fail on the reader even when the guard is bypassed. Table-page search
  escapes `LIKE` wildcards and is case-insensitive, and `in` filters match
  nothing when the list is empty.
- `src-tauri/src/recordstore/conformance.rs`: every scenario reads through
  DuckDB after writing through the store, on SQLite and on PostgreSQL when
  `IXTABLE_TEST_POSTGRES_URL` is set (the `postgres` CI job).
- `src-tauri/src/queries/tests.rs`: named placeholders rewritten outside
  literals, typed binding, injection attempts bound, mutating SQL rejected,
  cancellation.
- `src-tauri/src/queries/tests_page.rs`: saved-query pages run in DuckDB with
  exact totals, bound filters and checked column names, `in` filters that
  match nothing when empty, and literal case-insensitive search.
- `src-tauri/src/data/race_tests.rs` and `tests/integration/read-write-race.test.tsx`:
  concurrent writes and reads on one file and one session never fail, and
  each write is visible to the next read. Without the gate the integration
  test fails with `attempt to write a readonly database`.
- `tests/integration/sql-and-metadata.test.tsx` and
  `tests/integration/query-mode.test.tsx`: read SQL, write rejection,
  parameters, and cancel through the UI and the real bridge.
- [RecordStore and DuckDB type matrix](./recordstore-type-matrix.md).

## Audit log

- 2026-10-05: Added the failed-attach behavior and the guard's allowed leading
  keywords, and added `queries/tests_page.rs` and the paging, search, and dev
  copy tests to Evidence. Status unchanged: the macOS and Windows CI jobs have
  not passed on main.
