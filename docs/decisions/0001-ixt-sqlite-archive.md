# 0001. `.ixt` SQLite archive

Status: accepted

The `.ixt` file is a SQLite database. It is not a zip and not a SQLite Archive (`sqlar`) table. Versioned tables hold `archive_metadata`, compressed `data_payload`, JSON `document_config`, and attachment rows. `format_version` is the compatibility gate. Unknown future versions fail closed.

Working sessions extract `data.db`, `document.json`, and `config.yaml`. Those files are a cache. The `.ixt` file is authoritative after a successful save.

Autosave is a debounced call to the same write path as Save. The UI may show dirty, saving, saved, or error. Autosave never publishes a cloud checkpoint.

Proof: `src-tauri/src/phase0/checkpoint.rs` round-trips config and record-store bytes through `archive::write_archive` / `read_archive`.
