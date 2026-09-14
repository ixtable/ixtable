Pin DuckDB 1.5.5 scanners here by running:

```bash
scripts/prepare-duckdb-artifacts.sh linux-x64
```

The script writes `sqlite_scanner.duckdb_extension` and `postgres_scanner.duckdb_extension` under a target directory. Hashes live in `manifest.json`. Autoload stays off at runtime.
