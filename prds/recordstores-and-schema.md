# PRD: RecordStores & Schema

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Provide a backend-neutral transactional write contract for SQLite and PostgreSQL while exposing real backend capabilities.

## MVP RecordStores

- `SQLiteRecordStore`
- `PostgresRecordStore`

No managed PostgreSQL service is included.

## Contract

Every RecordStore reports capabilities for:

- logical types;
- table/column DDL;
- primary/composite keys;
- foreign keys;
- unique/check constraints;
- defaults;
- indexes;
- generated values;
- transactions;
- parameter binding;
- migration behavior;
- concurrency/conflict support; and
- normalized error mapping.

The UI must describe capabilities, not pretend all stores behave like SQLite.

## SQLite

- Default local transactional backend.
- Embedded SQLite state lives in the application archive for Studio/local runtime.
- Foreign keys must be enforced.
- Runtime-only distributed SQLite installations become independent local record states after first initialization.
- App-definition updates must preserve runtime-local records and apply explicit migrations.

## PostgreSQL

- Developer supplies hosting, networking, TLS, backups, and credentials.
- Runtime connects directly in MVP; ixtable does not proxy queries.
- Support shared application credentials and per-runtime-user credentials.
- Studio must warn when shared credentials reduce revocation/database attribution.
- Non-TLS connections require an explicit severe warning/override.

## Schema designer

The visual designer supports:

- tables/fields;
- logical types;
- nullability;
- keys;
- relationships;
- uniqueness;
- defaults;
- checks;
- indexes;
- cascade behavior.

Destructive changes require an impact preview.

## Migrations

- Schema-changing application updates use explicit ordered migrations.
- Migrations are transactional where the backend permits.
- Failed migrations do not activate the new app definition.
- Backend-specific rebuild operations are surfaced explicitly.
- Migration history is tied to application version.

## Acceptance criteria

- SQLite and PostgreSQL pass the same RecordStore conformance suite.
- Golden applications create equivalent logical schemas on both stores where capabilities overlap.
- Constraints fail with normalized, actionable errors.
- Runtime local SQLite data survives definition-only updates.
- Migration failure leaves prior runtime version usable.

## Non-goals

- MySQL/SQL Server in MVP;
- cloud-managed PostgreSQL;
- silently emulating unsupported backend features;
- routing writes through DuckDB.
