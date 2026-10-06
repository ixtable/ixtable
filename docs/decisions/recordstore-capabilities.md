# RecordStore capability contract and the PostgreSQL write path

Status: accepted. PostgreSQL conformance runs in CI on Linux only, through the
`postgres` job in `.github/workflows/desktop.yml`. Covers PRD §9, §10.1, §19,
§24, and the Phase 0 PostgreSQL write path and read-after-write spike.

## Context

An application stores records in the embedded SQLite file or in a
developer-provided PostgreSQL database. The two engines differ in DDL,
transactions, constraint errors, and concurrency. The PRD requires one
conformance suite for both, Studio UI that speaks in capabilities instead of
SQLite terms, and visible differences instead of silent emulation.

## Decision

### One trait for writes

`recordstore::RecordStore` is the write side. `SqliteRecordStore` uses
rusqlite against the session's `data.db`. `PostgresRecordStore` uses the
`postgres` crate, with TLS through the platform stack via `native-tls`.
`recordstore::for_session(window)` returns the store that the document's
`DatasourceConfig` selects. The trait covers:

- `insert`, `update`, and `delete`, plus `execute_batch` for atomic batches
- `create_table`, `plan_alter`, `alter_table`, `drop_table`, and index DDL
- `impact`, which previews row counts and dependents before a destructive change
- `run_script`, for migrations and schema scripts, with one transaction per script

A column's check is the set of table checks that mention that column and no
other (`plan::column_checks`). `alter_column` sets it to exactly
`definition.check`: a missing check or the same text keeps the stored checks,
new text replaces them, and an empty string removes them. Both stores apply
this through the shared plan; PostgreSQL drops and adds the named constraints
that differ. The schema designer shows the column's check and sends it only
when the user edited it, so a rename still carries the renamed check along.

Every write commits in the store, then the manager refreshes the DuckDB
reader (see [DuckDB read path](./duckdb-read-path.md)). Reads never use the
store connection.

### Published capabilities

`capabilities()` returns `StoreCapabilities`. The `store_capabilities` command
sends it to the schema designer, which labels each staged change by its mode.

| Area | SQLite | PostgreSQL |
|---|---|---|
| DDL | creating and dropping tables, renames, indexes, and most column adds and drops in place. Column alterations and key and constraint changes rebuild the table | every operation in place. Type changes use `USING` casts |
| Transactions | atomic batches, transactional DDL, savepoints, serializable with a single writer | the same, at read committed |
| Parameters | `?` | `$1` |
| Generated values | rowid alias, default expressions, virtual generated columns | identity columns, default expressions, stored generated columns |
| Script dry run | run on a copy, then discard | `BEGIN … ROLLBACK` on the live database |
| Script health check | `foreign_key_check` and `integrity_check` | constraint validation |
| Concurrency | `optimistic`, `lastWriteWins`, or `customAction` per entity, no row locks, single user | the same policies with row locking, multi user |

`inspect_table` reports `autoIncrement` on a column the database fills in on
insert: the SQLite rowid alias, or a PostgreSQL identity (`attidentity`) or
`nextval` (serial) default. Generated forms make only those keys read-only.
Rows written with explicit keys (an import) leave a PostgreSQL sequence
behind, so `RecordStore::sync_identity` then moves each identity or serial
sequence to the column's largest key with `setval`, only ever forward.
SQLite picks `max(rowid) + 1` itself, so it is a no-op there.

Native errors map to stable codes: `CONSTRAINT_VIOLATION` with the constraint
kind, `READ_ONLY`, `CONNECTION`, `BUSY`, `NOT_FOUND`, `CONFLICT`, `STALE_ROW`,
`VALIDATION_ERROR`, and `DATABASE_ERROR`. The capability object lists the
native codes behind each one.

Logical types and their physical mapping per store are in the
[type matrix](./recordstore-type-matrix.md).

### Studio reads capabilities, not store names

The table designer, the create-table form, and the relationship editor take
their logical type list from `logicalTypes` and their referential actions
from `foreignKeyActions`. While capabilities load, the designer says it is
checking the record store instead of assuming SQLite, and the default field
asks for a value or expression, not SQLite syntax. The Datasource tab shows
every category above as a read-only summary: constraints, relationship
actions, index kinds, transactions, parameter style, generated values,
migrations, concurrency, and the error code mapping.

### Every schema change is previewed

Dropping an index opens the same impact dialog as other changes, with the
`DROP INDEX` statement and an acknowledgement. Renaming a table or column
does not rewrite saved queries, forms, reports, dashboards, actions, or
triggers. `preview_table_changes` lists the definitions that use the old
name (`rename_dependents`: for a column, those that mention both the table
and the column) and adds a warning, and the designer asks for an
acknowledgement before it applies the rename. Rewriting bindings
automatically is not done: a name inside SQL text or an expression cannot be
rewritten deterministically.

Drawing a relationship on the diagram opens the relationship editor
prefilled with the drawn columns, so the user picks more columns and the
actions before the preview. Diagram edges anchor on every column of a
composite key and read `1 — 1` when the referencing columns are unique.

### Migrations target SQLite only

Declared migrations (PRD §24) run on the embedded SQLite store only.
PostgreSQL schema migrations are out of MVP scope: developers manage an
external database's schema themselves. A migration's `targetStore` is
`sqlite`. Older documents may say `any`, which reads as `sqlite`, or
`postgres`, which validation reports as an error. When the datasource is
PostgreSQL, the Migrations tab says migrations are disabled, and the dry run,
apply, and rollback commands return `VALIDATION_ERROR` without touching the
database. The schema designer still changes PostgreSQL tables through the
store's DDL and `run_script`.

This replaced an earlier design that ran migrations on PostgreSQL after the
developer confirmed an external backup (`BACKUP_REQUIRED`). A checkpoint
cannot copy PostgreSQL records, so recovery after a failed migration would
have depended on a backup that ixtable cannot check.

### Optimistic concurrency

`update_row`, `delete_row`, and the update and delete operations of
`execute_write_batch` accept the original values as `expected`. Rust enforces
the entity's policy at write time (`recordstore::commands::resolve_expected`):

- `optimistic`, `customAction`, and a table with no resolved policy need
  `expected`. An update or delete without it fails with `EXPECTED_REQUIRED`
  instead of overwriting blindly. The store compares the values in the
  `WHERE` clause. When no row matches, the write fails with `CONFLICT` and the
  grid shows the current values.
- `lastWriteWins` drops `expected`, so a stale edit overwrites.

Every frontend caller sends `expected`: the grid, Runtime forms, related lists,
and automation record steps, which send the values of the rows they matched.
Within one action run, a row the action already wrote sends its post-write
values as the next write's `expected` (in `rollback` mode, lookups still see the
data as it was before the action), and a step on a row the action deleted fails.
On a table with no primary key a `match: current` step sends the record as
loaded, not the form's unsaved edits.

A write that commits but whose sync trigger then fails rejects with
`CommittedWriteError`. A Runtime form treats it as saved: a created record opens
as saved (so Save again cannot insert a duplicate), an updated one reloads, and
the form shows `Saved.` with the trigger's error.

### Custom concurrency actions

Rust stores records; it does not run actions (expressions are evaluated only in
TypeScript). For a `customAction` entity, `updateRecord` and `deleteRecord` in
`src/lib/records.ts` run the entity's `actionId` instead of writing, through a
router that automation installs (`src/automation/custom.ts`). Update and delete
steps of an action do the same, joining the caller's transaction. Inserts are
unaffected. The action runs with:

- `record`: the row with the requested changes applied (the current row for a
  delete), so `match: current` targets it;
- `old`: the row before the change;
- `params.operation` (`update` or `delete`), `params.table`, `params.changes`
  (the requested column values), and `params.expected` (the original values the
  caller started from, or null).

A `match: current` step on the routed row sends the caller's original values
(the form or grid snapshot, else the row as read when the write began) as
`expected`, so a concurrent change raises `CONFLICT` from forms and grids alike.

Routing happens only in the TypeScript frontend. Rust treats `customAction`
like `optimistic` (it requires `expected`), so a direct `update_row` or
`delete_row` call with `expected` writes without running the action. The
frontend is the only client today.

The action's own record steps write directly, with no re-routing, under its
`onError` semantics; use `rollback` to make its writes one transaction. They
send `expected` like any optimistic write, so a row that changed after the
action read it still conflicts. A failing action rejects the caller's write.

Each of those writes goes through the same Rust authorization as any record
write (`authz::check`, or a trigger grant). A custom action started by a user's
save, or by a user-mode trigger, runs under the user's role, which must be
allowed to run the action. Inside an app-mode trigger it runs with the
trigger's grant: Rust counts the routed action's steps as steps the trigger
declares (`trigger_auth::action_steps`).

### Credentials and TLS

`DatasourceConfig` holds host, port, database, user, `sslmode`, schema,
credential mode, and a `passwordRef`. The password lives in the local secret
store, sealed with ChaCha20-Poly1305 under a random key in
`<state>/secrets/secret.key`. The archive never holds it. `sslmode=disable`
needs an explicit, recorded confirmation (PRD §21.4).

`secrets::datasource_login` returns the username and password a connection
uses: a cloud key grant first (which may name a per-user database user), then
a login entered in Runtime for the installation (`runtime-bundles.md`), then
`passwordRef`. `secrets::connection` applies that username to the datasource
for both the record store and the DuckDB reader. PostgreSQL authentication
failures (SQLSTATE class 28) map to `AUTH_FAILED`.

## Consequences

- The designer shows rebuilds on SQLite and in-place changes on PostgreSQL,
  so users see the real cost of a change.
- New stores must implement the trait, publish capabilities, and pass the
  conformance suite before they ship.
- PostgreSQL tests need a server, so the Rust ones are `#[ignore]`d with that
  reason and a plain `cargo test` lists them as ignored. Run them with
  `IXTABLE_TEST_POSTGRES_URL=... cargo test --lib -- --include-ignored recordstore postgres migrations data --skip perf_tests`.
  Without the variable they return early with a message, or panic when `CI` is
  set (`src-tauri/src/test_env.rs`). In CI the PostgreSQL jobs (a `postgres:16`
  service container on Linux, a native server on macOS and Windows) run them
  through `scripts/ci/run-ignored-rust-tests.mjs`, which fails unless every
  ignored test the filter selects ran and passed.
- PostgreSQL data is not part of the `.ixt` archive and is not backed up by
  ixtable. The datasource tab says so.

## Evidence

- `src-tauri/src/recordstore/conformance.rs` and `conformance_more.rs`, run
  on SQLite and PostgreSQL: CRUD visible to DuckDB after each commit,
  constraint codes and cascades, atomic batches with bound values, logical
  types round-tripping through DuckDB, optimistic updates rejecting stale
  values, write-time policies (`EXPECTED_REQUIRED` and `CONFLICT` for
  optimistic, overwrite for `lastWriteWins`), store-specific schema change
  modes that keep data, transactional scripts with rollback, and column
  checks kept, replaced, or removed by `alter_column`.
- `tests/unit/automation-write-path.test.ts`: automation sends `expected`,
  custom concurrency actions from `records.ts` and from action steps.
- `tests/integration/automation-runtime.test.tsx`: a custom concurrency action
  replaces the write; a blind `update_row` fails with `EXPECTED_REQUIRED`.
- `src-tauri/src/recordstore/sqlite_tests.rs` and
  `src-tauri/src/migrations/tests.rs`.
- `tests/integration/schema-designer.test.tsx`: changes labelled by store
  capability, rebuild and drop previews, rename dependents, index drop
  preview, drafts kept through a metadata reload, and a relationship created
  through the relationship editor.
- `src-tauri/src/recordstore/plan_tests.rs`: rename dependents.
- `tests/unit/store-capabilities-ui.test.tsx` and
  `tests/unit/relationships.test.ts`: capability-driven pickers, the
  capability summary, composite edges and cardinality labels.
- `tests/integration/optimistic-grid.test.tsx`: a stale grid edit is rejected.
- `tests/unit/automation-expected.test.ts`: rows written twice in one run
  (rollback and immediate, keyed and keyless), custom actions conflicting on a
  stale form snapshot, keyless `expected` from the loaded record.
- `tests/integration/runtime-committed-write.test.tsx`: same-row writes in a
  rollback action, and Runtime forms treating a committed write with a failed
  sync trigger as saved.
- `tests/integration/migrations.test.tsx`: dry run, apply with checkpoint,
  rollback, a failing migration, a legacy `postgres` target flagged as an
  error, and migrations disabled for a PostgreSQL document.
- `tests/integration/datasource.test.tsx`: non-TLS override, concurrency
  policy per table, and, with a PostgreSQL URL, switching reads and writes to
  PostgreSQL without storing the password in the document, with migrations
  disabled for it.

## Audit log

- 2026-10-05: Corrected the SQLite DDL, transaction, and generated-value rows
  to match `capabilities.rs`, and added `conformance_more.rs` to the evidence.
