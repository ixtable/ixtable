# PRD: DuckDB Read & Query Engine

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Make DuckDB the single application read plane for records, saved queries, reports, dashboards, and supported external sources.

## Architecture

All reads flow through DuckDB. All mutations flow directly to the selected RecordStore.

DuckDB may use only curated, bundled, signed extensions in MVP.

## Required read paths

- table/list views;
- record detail retrieval;
- relationship selectors;
- saved queries;
- form datasets;
- report datasets;
- dashboard/chart datasets;
- supported external read-only sources.

## Query objects

Saved queries support:

- sources;
- joins;
- projected fields and aliases;
- filters;
- grouping;
- aggregates;
- sorting;
- parameters;
- preview;
- raw SQL for advanced users.

Saved queries are read-only. Mutating SQL belongs in migrations or explicit actions.

## Consistency contract

The system must define and test:

- commit-before-dependent-read;
- read-your-writes behavior;
- DuckDB connection/view refresh after mutations;
- transaction-error propagation;
- logical type equivalence;
- null/date-time/decimal behavior;
- parameter binding; and
- cancellation for long-running queries.

## Extension policy

- Extension allowlist is fixed for a release.
- Arbitrary install/load is prohibited.
- Extension packaging must be reproducible on all supported OSes.
- Missing extension support is a release blocker for required datasources.

## Acceptance criteria

- Every application read path can be traced to DuckDB.
- SQLite and PostgreSQL fixtures produce equivalent logical results where promised.
- Write followed immediately by dependent read returns committed state.
- Parameterized queries do not concatenate user input into SQL.
- Long-running report/dashboard queries expose cancellation/progress after the parent PRD threshold.

## Non-goals

- write-through DuckDB;
- arbitrary extensions;
- cloud query proxying;
- hidden backend-specific query semantics presented as portable.
