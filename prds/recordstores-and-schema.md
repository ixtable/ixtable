# PRD: RecordStores & Schema

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Provide a backend-neutral transactional mutation and schema contract for SQLite and PostgreSQL while exposing genuine backend capability differences.

## Architectural boundary

The RecordStore owns:

- transactional creates/updates/deletes;
- schema introspection;
- DDL and migrations;
- constraint/index metadata;
- backend-native transaction boundaries;
- normalized mutation/schema errors.

DuckDB owns application reads. Writes never flow through DuckDB.

## MVP RecordStores

- `SQLiteRecordStore`
- `PostgresRecordStore`

SQLite is implemented first, but the public contract must not bake SQLite-only assumptions into UI or serialized application definitions.

No managed PostgreSQL service is included.

## Capability descriptor

Every RecordStore reports capabilities for at least:

- logical types and type mapping;
- create/drop/rename table;
- add/drop/rename/change column;
- primary/composite keys;
- foreign keys and referential actions;
- unique/check constraints;
- defaults;
- indexes;
- generated/default-generated values;
- transactions;
- parameter binding;
- migration atomicity/rebuild requirements;
- concurrency/conflict facilities;
- identifier limits/case behavior;
- normalized error mapping.

The schema designer consumes this descriptor. Unsupported operations are disabled or explained; they are not silently emulated unless the contract explicitly defines emulation.

## Logical type contract

ixtable requires a backend-neutral logical type layer.

For every logical type, conformance fixtures must define:

- accepted input representation;
- SQLite physical mapping;
- PostgreSQL physical mapping;
- DuckDB read representation;
- null behavior;
- comparison/sort expectations;
- serialization into UI/API values;
- round-trip guarantees and known precision limits.

At minimum the MVP must resolve behavior for text, integer, floating numeric, **exact decimal**, boolean, date, time, timestamp/date-time, binary/blob, and identifiers used by relationships. Exact decimal must not be implemented as binary floating point; scale/precision and round-trip behavior are part of the portable logical-type contract.

Backend-specific types may be exposed as advanced capabilities but must not masquerade as portable logical types.

## SQLite

- Default local transactional backend.
- Embedded Studio/local-runtime state uses workspace `data.db`, checkpointed into archive `data_payload`.
- Foreign-key enforcement is enabled for every mutation connection.
- Runtime-only distributed SQLite installations initialize from the bundle once.
- Thereafter record data belongs to that installation.
- Definition updates preserve installation-local data and execute declared application migrations.

SQLite table-rebuild operations must be represented as migration operations with impact preview rather than hidden behind an in-place-DDL fiction.

## PostgreSQL

- Developer supplies hosting, networking, TLS, lifecycle, backups, and availability.
- Runtime connects directly in MVP; ixtable does not proxy PostgreSQL.
- An application may define **multiple independent PostgreSQL connections**.
- Each PostgreSQL connection has its own datasource identity, host/database/options, schema visibility, credential reference, and TLS policy.
- Each connection may independently use shared application credentials or per-runtime-user credentials.
- Studio warns that shared credentials weaken individual revocation and database-level attribution.
- Non-TLS configuration requires a severe explicit warning/override and remains visible in validation/audit state.

PostgreSQL supports **full multi-schema access within a configured connection**. Schema-qualified object identity is part of the datasource/object contract; implementors must not flatten PostgreSQL into SQLite's single-schema model. Introspection, query building, relationships, and migrations must preserve schema qualification.

## Mutation API

Normal record mutation entry points must be typed operations, not arbitrary SQL strings. Editable entities must expose an explicit stable primary/unique key; ixtable does not update rows by comparing all original column values and does not silently inject hidden row IDs into external schemas.

Required classes:

- insert record;
- update record by stable row identity/key;
- delete record by stable row identity/key;
- transactional batch where required by an action;
- schema/migration execution through the migration subsystem.

Values are parameter-bound. Identifiers originate from validated schema metadata and are safely quoted.

## Schema introspection and designer

Composite primary keys are fully supported for CRUD, relationships, query binding, and migrations in MVP.

The visual schema designer supports:

- tables/fields;
- logical types;
- nullability;
- primary/composite keys;
- foreign keys/relationships;
- unique constraints;
- defaults;
- check constraints;
- indexes;
- update/delete referential actions.

Introspection must round-trip schemas created by ixtable without losing supported semantics.

Destructive or rebuild-requiring changes display:

- affected objects;
- data-loss risk;
- dependent application objects where known;
- backend-specific execution strategy.

## Application migrations

Application migrations evolve runtime record schema/data and are distinct from archive/config migrations.

Migration authoring depends on application authoring mode:

- **Studio-managed apps:** migration definitions live inside the application definition and may use visual operations plus an advanced SQL escape hatch.
- **YAML IaC apps:** migrations may be external `.sql` files referenced from YAML, following an Ecto-style filesystem workflow. SQL files are the authoritative migration source for those entries rather than duplicated SQL embedded in YAML.

Applied migration execution history lives in each target data store.

Each migration has:

- stable migration ID;
- application version/order;
- target RecordStore(s) or portable capability requirement;
- ordered operations authored through visual migration operations with an advanced raw-SQL escape hatch for Studio-managed apps, or external SQL migration files for YAML IaC apps;
- explicit target backend/datasource scope when backend-specific behavior is used;
- atomicity expectation;
- forward transform;
- optional explicit reverse transform;
- checksum/identity over the authoritative migration definition/file contents so an already-applied migration cannot silently change.

### YAML IaC migration files

For YAML IaC apps:

- migration files use stable sortable names such as `YYYYMMDDHHMMSS_description.sql` or an equivalent monotonically ordered identifier;
- YAML declares the target datasource/connection and migration directory/list;
- migration order is derived deterministically from the stable migration identifier;
- each file is checksummed from exact bytes/content normalization policy defined by implementation;
- migration files are packaged into the application/runtime bundle required to execute pending migrations;
- path traversal outside the IaC project root is rejected;
- duplicate migration IDs are invalid;
- renaming or modifying a migration that has already been applied is rejected by checksum/history validation;
- future support for paired `up`/`down` files or migration metadata may be added, but MVP must not infer unsafe reversibility from arbitrary SQL.

Rules:

- unapplied migration definitions/files may be edited;
- once a migration ID/checksum has been applied to any target, that historical migration identity/content is immutable;
- applied migration history is stored with the runtime data state, not only the application definition;
- a changed checksum for an already-applied migration is an error;
- failed migration prevents activation of the new application definition;
- transactional stores roll back atomically where supported;
- non-atomic backend behavior requires preflight/restore strategy before it can be considered supported.

## Concurrency contract

Transactions alone are not conflict handling.

Shared PostgreSQL entities use **explicit optimistic concurrency via a version column** for editable concurrent records. The developer must designate a compatible version column for each concurrently editable entity; ixtable does not inject a hidden version field in MVP. Updates/deletes include the previously read version value in the mutation predicate and increment/update the version atomically. A zero-row mutation caused by a stale version is surfaced as a normalized concurrency conflict rather than silently overwriting data.

Independent local SQLite installations do not participate in multi-user conflict resolution.

## Datasource identity

Every datasource has a stable datasource ID. References to PostgreSQL objects are qualified as `datasource -> schema -> object` rather than assuming table names are globally unique across the application. SQLite uses the same datasource-ID abstraction even though its embedded default store has a single primary namespace.

## Normalized errors

Callers must be able to distinguish at least:

- validation/type error;
- not-null violation;
- unique violation;
- foreign-key violation;
- check violation;
- missing object;
- concurrency conflict;
- connectivity/authentication error;
- migration/DDL failure.

Backend-native diagnostic detail may be attached, but UI behavior must not depend on parsing raw database error strings.

## Acceptance criteria

- SQLite and PostgreSQL pass one RecordStore conformance suite for shared capabilities.
- Logical-type fixtures round-trip through RecordStore writes and DuckDB reads.
- Golden applications create equivalent logical schemas on both stores where capabilities overlap.
- Constraint violations map to normalized actionable errors.
- Mutation APIs use bound values and validated identifiers.
- Runtime local SQLite data survives definition-only updates.
- Applied migration history prevents mutation of historical migrations.
- Failed migration leaves the previous runtime application version usable.
- Concurrent PostgreSQL update/delete conflicts are detected through the designated explicit version column and surfaced as normalized concurrency conflicts.
- One application can define and use multiple PostgreSQL connections with independent credentials and schema namespaces.
- PostgreSQL introspection/querying preserves schema-qualified identity across multiple schemas.
- Schema introspection round-trips ixtable-created supported constraints/indexes.
- Editable tables without an explicit stable primary/unique key are rejected for mutation while remaining eligible for read-only use.
- Composite primary keys work across CRUD and relationship fixtures.
- Exact decimal fixtures round-trip without binary-floating-point corruption.
- Migration definitions can target a specific datasource/backend and applied histories are tracked per target.
- YAML IaC apps can execute ordered external SQL migration files whose IDs/checksums are validated against per-target migration history.

## Non-goals

- MySQL/SQL Server in MVP;
- cloud-managed PostgreSQL;
- silently emulating every backend feature;
- routing writes through DuckDB;
- SQLite multi-user synchronization.
