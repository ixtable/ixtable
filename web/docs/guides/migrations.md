---
sidebar_position: 7
---

# Migrations

_Migrations are ordered SQL changes to the embedded SQLite database. ixtable checkpoints the project, runs each one in its own transaction, checks database health, and logs the result._

A **migration** is SQL you write to change the schema or records of the embedded database, with an `up` script and an optional `down` script. Migrations live in the project file, so they travel with the application. ixtable runs them when you apply them in Studio and again on each recipient's records when they install a [runtime bundle](./runtime-bundles) update.

Open Settings, then the **Migrations** tab. The tab lists the declared migrations in order with their target and status, and the log of past runs below.

## Write a migration

Choose **New migration**. The editor has these fields:

| Field | Meaning |
| --- | --- |
| Name | A label for the migration. You can rename it at any time |
| Order | The position in the run order. Every migration needs a different order |
| Target store | Embedded SQLite |
| Depends on | Other migrations that must run first. A dependency must have a lower order |
| Reversible | Marks the migration as safe to undo. A reversible migration needs down SQL |
| Up SQL | The SQL that applies the change |
| Down SQL | The SQL that undoes the change |

Each migration also has an id that never changes. ixtable tracks applied migrations by that id, so renaming one does not run it again.

Do not write `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, or similar statements. ixtable wraps each migration in its own transaction and reports these keywords as a problem. Keywords inside strings, comments, and `CREATE TRIGGER` bodies are fine.

```sql
ALTER TABLE contacts ADD COLUMN phone TEXT;
UPDATE contacts SET phone = '' WHERE phone IS NULL;
```

## Preview SQL

**Preview SQL** splits the up SQL into statements the way SQLite does, so semicolons inside strings and trigger bodies do not split a statement. It shows the statement count and warns about statements that need attention:

- `DROP TABLE` and `DROP COLUMN` destroy records.
- `VACUUM` and `CONCURRENTLY` cannot run inside a transaction.
- `PRAGMA foreign_keys` has no effect inside a transaction.

**Preview down SQL** does the same for the down script.

## Dry run and apply

**Dry run pending** runs every pending migration on a copy of the database, runs the health checks, and throws the copy away. It reports whether the run succeeded and changes nothing.

**Apply pending** runs the pending migrations in order:

1. ixtable saves a recovery checkpoint of the project. If the checkpoint fails, no migration runs.
2. Each migration runs in its own transaction.
3. Inside that transaction, ixtable checks foreign keys and database integrity. A failure rolls the migration back.
4. ixtable records the migration as applied and commits.

The run stops at the first failure, and later migrations do not run. Migrations that committed earlier in the same run stay applied. The **Last run** section names the checkpoint taken before the run.

After a run, ixtable checks the project again. Forms, queries, and other definitions that refer to a dropped table or column appear under **Problems after migration** and in the Problems tab.

## The migration log

The **Migration log** lists every run on this database, including dry runs and failures. Each entry shows the direction, the status, the start and finish times, the health check result, and any error.

A failed entry includes recovery instructions. The failed migration's transaction was rolled back, so the database is unchanged by it. Fix the SQL or add a new migration, then apply again. If records still look wrong, restore the pre-migration checkpoint as a copy from Settings, then **Assets**, then **Checkpoints**.

A statement that cannot run inside a transaction, such as `VACUUM`, must be run against the database by hand. ixtable does not run it.

## Applied migrations are locked

Once a migration is applied, its up SQL, order, dependencies, and reversible flag are locked. To change the schema again, add a new migration. You can still rename it, and you can add down SQL if it had none.

ixtable stores a checksum of each applied migration's up SQL. If the up SQL changes anyway, for example in an edited project file, the status reads **Changed after apply**. Apply, dry run, and runtime updates then refuse to run until you restore the original SQL.

## Roll back

**Roll back last** undoes the most recently applied migration. ixtable saves a checkpoint, runs the down SQL in one transaction with the same health checks, and marks the migration as no longer applied.

Only a migration marked reversible with down SQL can roll back. Many changes cannot be reversed safely, such as dropping a column that held data. For those, restore a checkpoint or write a new migration instead.

## PostgreSQL

Migrations apply to the embedded SQLite database only. When a project uses a PostgreSQL datasource, the Migrations tab disables dry run, apply, and roll back. You manage the PostgreSQL schema yourself, with your own tools.

## Migrations in runtime updates

Each installed copy of a runtime bundle keeps its own records and its own list of applied migrations. When a recipient installs an update, ixtable runs the migrations that their records have not seen yet, in order, on a copy of their data. Any failure leaves the previous version in place. [Runtime bundles](./runtime-bundles) describes the update in detail.

A project with migration problems cannot be exported as a bundle until you fix them.

## Next steps

- [Runtime bundles](./runtime-bundles)
- [Data view](../concepts/data-view)
