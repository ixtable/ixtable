# Phase 0 decision records

_Exit criteria for risk retirement. Each spike has a decision and an automated proof._

Phase 0 exists to freeze architecture contracts before the kernel grows. Desktop-only Studio and Runtime stay the product shape. No spike found a blocker that forces a hosted database or a browser runtime.

| Spike | Decision | Proof |
| --- | --- | --- |
| `.ixt` archive autosave | [0001](0001-ixt-sqlite-archive.md) | `phase0::checkpoint` |
| Atomic checkpoints | [0002](0002-atomic-checkpoints.md) | `interrupted_write_keeps_last_valid_checkpoint` |
| Shared grid | [0003](0003-shared-grid.md) | `design` rust tests plus `tests/grid-css.test.ts` |
| DuckDB scanners | [0004](0004-duckdb-scanners.md) | `phase0::duckdb_ext` and `postgres_store` |
| PostgreSQL DuckDB writes | [0005](0005-postgres-read-after-write.md) | `postgres_write_is_visible_to_duckdb` |
| Report PDF | [0006](0006-report-pagination.md) | `phase0::report` |
| Password runtime bundle | [0007](0007-password-runtime-bundle.md) | `phase0::runtime_bundle` |
| Signed bundle and envelope | [0008](0008-signed-bundle-envelope.md) | `phase0::runtime_bundle` |
| Async trigger queue | [0009](0009-async-trigger-queue.md) | `phase0::trigger_queue` |
| Logical types | [0010](0010-logical-types.md) | `phase0::types` |

Run the proofs from `src-tauri`:

```bash
scripts/prepare-duckdb-artifacts.sh linux-x64
cargo test
```

Set `IXTABLE_POSTGRES_URL` when a PostgreSQL instance is available. The PostgreSQL DuckDB test returns without failing when the URL or scanner file is missing. CI starts Postgres and fetches both scanners so that path executes there.
