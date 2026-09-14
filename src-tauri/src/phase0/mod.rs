//! Phase 0 architecture spikes. Production code still lives in `archive`,
//! `data`, and `design`. These modules retire remaining risk with automated
//! proofs and written decisions under `docs/decisions`.
pub mod checkpoint;
pub mod duckdb_ext;
pub mod postgres_store;
pub mod report;
pub mod runtime_bundle;
pub mod trigger_queue;
pub mod types;
