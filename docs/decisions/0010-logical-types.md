# 0010. RecordStore and DuckDB logical types

Status: accepted

Logical types are the product contract. Sqlite, PostgreSQL, and DuckDB publish physical types through the matrix in `phase0::types::MATRIX`. Differences stay visible. Sqlite booleans are integers. Money is decimal text on sqlite and numeric on PostgreSQL. Do not emulate Postgres jsonb key order on sqlite.

The application RecordStore is DuckDB. Identity integers use the full 64-bit signed range. Reals reject NaN and infinities at the RecordStore boundary. Dates are ISO-8601. Timestamps are RFC3339 UTC.

A conformance failure across engines blocks architecture progression. Backend-specific UI behavior is not an escape hatch.

Proof lives in `matrix_covers_mvp_logical_types`, `duckdb_storage_types_match_the_matrix`, and `duckdb_reads_native_logical_values`.
