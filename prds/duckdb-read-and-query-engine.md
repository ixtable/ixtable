# PRD: DuckDB Read & Query Engine

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Make DuckDB the single application read plane for records, saved queries, forms, reports, dashboards, relationship selectors, and supported external read-only sources.

## Architectural boundary

```text
Read
  -> DuckDB session runtime
     -> embedded SQLite workspace / PostgreSQL / allowlisted external source

Write
  -> RecordStore
     -> SQLite / PostgreSQL
  -> refresh/invalidate DuckDB session state as required
```

A feature that reads application data directly through SQLite/PostgreSQL APIs instead of DuckDB violates the MVP architecture unless it is schema/metadata introspection explicitly owned by the RecordStore.

## Session runtime

Each open application owns a session-scoped DuckDB read runtime.

For embedded SQLite:

- DuckDB reads the extracted working-session `data.db`, not compressed archive bytes.
- After a successful RecordStore mutation, the read runtime is refreshed/invalidated before a dependent application read.
- Closing the application tears down its read runtime.

For PostgreSQL, connection/session strategy must preserve the same read-after-write contract even when DuckDB and the mutation connection are separate database sessions.

## Required read paths

All of these use DuckDB:

- table/list pages;
- record/detail data retrieval;
- relationship selectors;
- saved queries;
- form datasets;
- report datasets;
- dashboard/chart datasets;
- filter option datasets;
- supported external read-only sources.

RecordStore schema introspection is not considered an application data read path.

## Saved query model

Every saved query has at least:

- immutable stable ID;
- mutable display name;
- canonical typed query AST for visual-mode queries;
- typed parameter definitions;
- cached/introspected output schema;
- optional persisted designer/filter state.

Visual-mode queries use the typed AST as canonical definition and deterministically generate DuckDB SQL. Raw-SQL queries are a separate explicit query mode whose SQL text is canonical.

## Visual query builder

The visual builder supports:

- source selection;
- joins;
- fields/aliases;
- filters;
- grouping;
- aggregates;
- sorting;
- parameters;
- preview.

Advanced users may use raw SQL in a separate query mode. Conversion from raw SQL back to visual mode is offered only when the SQL can be represented losslessly by the visual AST. Unsupported constructs remain raw SQL; ixtable never silently discards semantics.

## Cross-datasource queries

DuckDB may join/read across multiple configured datasources, including the embedded SQLite store and multiple PostgreSQL connections/schemas, subject to extension and credential policy. Cross-datasource reads are a first-class query capability.

Cross-datasource writes are not supported. Each mutation is scoped to one RecordStore/datasource transaction. Actions may sequence independent mutations across stores only under the non-atomic semantics defined by the Actions PRD.

## Query output schema

The query subsystem introspects and caches a saved query's declared output schema. The schema is invalidated/recomputed when the canonical query definition or relevant datasource schema changes. Consumers bind to stable query identity plus output field identity/alias metadata rather than re-inferring ad hoc on every render.

## Read-only enforcement

Saved/read queries are read-only.

The runtime must reject statements that mutate state or alter schema, including indirect multi-statement attempts.

Do not rely only on UI affordances. Enforcement belongs at the query execution boundary.

Mutating SQL belongs only in:

- application migrations; or
- explicit action capabilities that route through approved mutation APIs.

## Parameters

Query parameters are typed application inputs.

Requirements:

- parameter definitions are explicit and typed in application config;
- values use parameter binding;
- user input is never concatenated into SQL;
- identifiers cannot be supplied through ordinary value parameters;
- parameter defaults and nullability are explicit;
- the same logical parameter type behaves consistently across SQLite/PostgreSQL-backed queries where portability is promised.

## Consistency contract

### Read-after-write

For an application flow:

1. RecordStore mutation succeeds and commits.
2. Any necessary DuckDB attachment/view/session refresh completes.
3. The dependent read is allowed to execute.
4. The read must observe the committed mutation.

A mutation API returning success before the read plane can satisfy this contract is a bug.

### Transaction failures

If mutation commit fails:

- DuckDB refresh does not make uncommitted state visible;
- dependent reads execute against the last committed state;
- callers receive a normalized mutation error.

### Cross-engine semantics

Conformance tests define promised behavior for:

- nulls;
- booleans;
- integer/numeric/decimal precision;
- dates/times/timestamps/time zones;
- binary values;
- sorting/collation where portable;
- parameter conversion.

Where identical semantics cannot be guaranteed, the limitation must be explicit rather than hidden.

## Extension security and packaging

- DuckDB automatic extension loading/install is disabled.
- External access is enabled only as required for allowlisted datasource functionality.
- Extensions are bundled or otherwise pinned by ixtable release.
- Extension binaries are integrity-checked before load.
- The allowlist is fixed for a release.
- Arbitrary extension install/load is prohibited.
- Required extension artifacts must be reproducible and tested on every supported platform/architecture in the release matrix.

MVP starts with the extension(s) required for SQLite and PostgreSQL integration. Adding another extension-backed source requires explicit capability/security review.

## Pagination and interactive limits

Interactive query consumers use bounded paged reads rather than materializing full result sets client-side. Preview/table/dashboard components enforce configurable product limits on rows/materialized bytes. Export/report pipelines may stream or chunk beyond interactive limits.

## Query caching

MVP does not introduce a general automatic query-result cache. Correctness and predictable invalidation take priority. Individual future components may add explicit cache semantics only with documented invalidation rules.

## PostgreSQL read credentials

DuckDB reuses the configured datasource credential by default. A developer may optionally configure a distinct read-only credential/reference for a PostgreSQL datasource. Both forms remain scoped to that datasource's stable ID.

## Cancellation, progress, and resource limits

- Each application has a session-scoped DuckDB runtime capable of cancellable concurrent reads; there is no single process-global query connection and no requirement to create one connection per query.
- Long-running report/dashboard/query preview work must be cancellable.
- Progress/running state is exposed after the parent PRD threshold.
- Cancellation must not corrupt the session runtime.
- Implementors must define practical row/page/result limits for interactive previews so a query cannot accidentally materialize an unbounded UI payload.

Full exports/reports may use streaming/chunked paths separate from interactive preview limits.

## Error model

Callers must be able to distinguish:

- invalid/read-write-prohibited SQL;
- parameter error;
- datasource unavailable/auth failure;
- extension startup/integrity failure;
- query cancellation;
- query execution failure;
- unsupported logical conversion.

Raw engine diagnostics may be attached for debugging but should not be the only structured error contract.

## Acceptance criteria

- Every application data read path can be traced to DuckDB.
- Direct embedded-SQLite reads outside DuckDB are limited to RecordStore-owned schema/metadata operations.
- SQLite and PostgreSQL fixtures produce equivalent logical results where promised.
- Write followed immediately by dependent read returns committed state.
- A mutation reported as failed is never visible as committed through DuckDB.
- Parameterized queries never concatenate user-provided values into SQL.
- Read-only execution rejects mutating and multi-statement bypass attempts.
- Bundled extension integrity failure prevents runtime startup/read use rather than falling back to arbitrary installation.
- Long-running report/dashboard/query preview work supports cancellation and visible running/progress state.
- Visual saved queries use a canonical typed AST and deterministically generated SQL.
- Raw SQL that cannot round-trip losslessly through the visual builder remains in raw-SQL mode.
- Cross-datasource joins work through DuckDB while mutations remain single-RecordStore scoped.
- Query parameters are explicit typed definitions.
- Interactive consumers use bounded pagination/result limits while exports may stream larger results.
- Query output schemas are cached/introspected and invalidated when definitions/schema change.

## Non-goals

- write-through DuckDB;
- arbitrary extensions;
- cloud query proxying;
- silently normalizing incompatible backend semantics;
- using DuckDB as the authoritative transactional store.
