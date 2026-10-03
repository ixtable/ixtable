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
- `run_script`, for migrations, with one transaction per script

Every write commits in the store, then the manager refreshes the DuckDB
reader (see [DuckDB read path](./duckdb-read-path.md)). Reads never use the
store connection.

### Published capabilities

`capabilities()` returns `StoreCapabilities`. The `store_capabilities` command
sends it to the schema designer, which labels each staged change by its mode.

| Area | SQLite | PostgreSQL |
|---|---|---|
| DDL | `create_table`, renames, and indexes in place. Type, key, constraint, and most column changes rebuild the table | every operation in place. Type changes use `USING` casts |
| Transactions | atomic batches, transactional DDL, savepoints | the same, at read committed |
| Parameters | `?` | `$1` |
| Generated values | rowid alias, default expressions | identity columns, default expressions, stored generated columns |
| Migration dry run | run on a copy, then discard | `BEGIN … ROLLBACK` on the live database |
| Migration health check | `foreign_key_check` and `integrity_check` | constraint validation |
| Concurrency | `optimistic`, `lastWriteWins`, or `customAction` per entity, no row locks, single user | the same policies with row locking, multi user |

Native errors map to stable codes: `CONSTRAINT_VIOLATION` with the constraint
kind, `READ_ONLY`, `CONNECTION`, `BUSY`, `NOT_FOUND`, `CONFLICT`, `STALE_ROW`,
`VALIDATION_ERROR`, and `DATABASE_ERROR`. The capability object lists the
native codes behind each one.

Logical types and their physical mapping per store are in the
[type matrix](./recordstore-type-matrix.md).

### Optimistic concurrency

`update_row` and `delete_row` accept the original values as `expected`. For
tables with the `optimistic` policy, the store compares them in the `WHERE`
clause. When no row matches, the write fails with `CONFLICT` and the grid
shows the current values.

### Credentials and TLS

`DatasourceConfig` holds host, port, database, user, `sslmode`, schema,
credential mode, and a `passwordRef`. The password lives in the local secret
store, sealed with ChaCha20-Poly1305 under a random key in
`<state>/secrets/secret.key`. The archive never holds it. `sslmode=disable`
needs an explicit, recorded confirmation (PRD §21.4).

## Consequences

- The designer shows rebuilds on SQLite and in-place changes on PostgreSQL,
  so users see the real cost of a change.
- New stores must implement the trait, publish capabilities, and pass the
  conformance suite before they ship.
- PostgreSQL tests need a server. Locally they skip unless
  `IXTABLE_TEST_POSTGRES_URL` is set. In CI they run against a `postgres:16`
  service container on Linux.
- PostgreSQL data is not part of the `.ixt` archive and is not backed up by
  ixtable. The datasource tab says so.

## Evidence

- `src-tauri/src/recordstore/conformance.rs`, run on SQLite and PostgreSQL:
  CRUD visible to DuckDB after each commit, constraint codes and cascades,
  atomic batches with bound values, logical types round-tripping through
  DuckDB, optimistic updates rejecting stale values, store-specific schema
  change modes that keep data, and transactional migrations with rollback.
- `src-tauri/src/recordstore/sqlite_tests.rs` and
  `src-tauri/src/migrations/tests.rs`.
- `tests/integration/schema-designer.test.tsx`: changes labelled by store
  capability, rebuild and drop previews.
- `tests/integration/optimistic-grid.test.tsx`: a stale grid edit is rejected.
- `tests/integration/migrations.test.tsx`: dry run, apply with checkpoint,
  rollback, and a failing migration.
- `tests/integration/datasource.test.tsx`: non-TLS override, concurrency
  policy per table, and, with a PostgreSQL URL, switching reads and writes to
  PostgreSQL without storing the password in the document.
