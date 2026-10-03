scripts/prepare-duckdb-artifacts.sh places the pinned sqlite_scanner and postgres_scanner
extensions in target-specific subdirectories here: the official .duckdb_extension.gz archives
(the only files the app bundles) and unpacked copies for dev builds and tests.
