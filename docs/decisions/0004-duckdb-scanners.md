# 0004. DuckDB scanners on three OSes

Status: accepted

The local RecordStore is a DuckDB file. Application inserts, updates, and deletes are DuckDB SQL on that file. PostgreSQL uses the same DuckDB SQL after `ATTACH ... (TYPE POSTGRES)` with the hashed `postgres_scanner`. Autoload is off. Missing scanner files fail at startup. Arbitrary extension install is deferred.

The official `sqlite_scanner` stays in the artifact set for archive inspection and import. It is not the write path. `sqlite_scanner` attach plus insert segfaulted on the Linux 1.5.5 build used in this spike.

`scripts/prepare-duckdb-artifacts.sh` downloads gzip artifacts over HTTPS and checks `compressedSha256` from `src-tauri/resources/duckdb/manifest.json`. Targets are `linux-x64`, `windows-x64`, `macos-x64`, and `macos-arm64`. CI fetches the Linux pair on every Phase 0 run. macOS and Windows packaging jobs must run the same script for their target. A platform ships only when its hashed scanners load.

DuckDB stays in-process in the desktop app. That keeps the product off a hosted query service.

Proof: `manifest_covers_current_os_for_both_scanners`, `duckdb_inserts_local_rows`, and the PostgreSQL attach test in [0005](0005-postgres-read-after-write.md).
