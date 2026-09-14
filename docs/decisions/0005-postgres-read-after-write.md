# 0005. PostgreSQL write path and read-after-write

Status: accepted

Inserts, updates, and deletes run as DuckDB SQL on the local DuckDB RecordStore file. PostgreSQL uses the same DuckDB session after `ATTACH ... (TYPE POSTGRES)`. There is no rusqlite or postgres-crate write path for application rows.

Connection strings stay out of the archive. Phase 4 wraps them in the envelope from [0008](0008-signed-bundle-envelope.md).

Transport encryption is the developer's setting. Unencrypted connections are allowed only after an explicit warning later. This spike uses local tcp or a unix socket.

If DuckDB cannot insert or cannot see a committed row, that is a release blocker. Do not add a sqlite-only write fallback.

The automated proof is `postgres_write_is_visible_to_duckdb` when `IXTABLE_POSTGRES_URL` or a local `ixtable_phase0` database is present.
