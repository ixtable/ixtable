# Record triggers and the local async job queue

Status: accepted. Covers PRD §17.3 and the Phase 0 local async trigger queue
spike.

## Context

The MVP supports record-created and record-updated triggers. A trigger runs an
action either inside the initiating workflow or later through a durable local
queue. The queue only runs while the desktop app is open, and it must provide
retries, status, attempt history, cancellation, and idempotency keys.
Schedules, webhooks, and always-on workers are deferred.

## Decision

### Where triggers fire

`src/lib/records.ts` is the only frontend write path. Automation registers a
record hook there (`registerRecordHook`), so every insert and update from
forms, grids, dashboards, and actions passes through trigger matching in
`src/automation/triggers.ts`.

- **Sync triggers** run their action after the write commits, and the caller
  awaits them. A failing sync trigger makes the caller's `insertRecord` or
  `updateRecord` reject. The record write itself has already committed. An
  action in rollback mode only undoes its own writes.
- **Async triggers** enqueue a job and return at once.
- Each write carries its trigger depth. A chain deeper than 5 fails, which
  stops trigger loops.

### The queue

`src-tauri/src/jobs.rs` keeps jobs in `<state>/data/jobs.db`, a SQLite file
in WAL mode next to the global store. Jobs are keyed by the record store they
belong to (`store_key`): `studio:<documentId>` for Studio sessions of a
document, `runtime:<bundleId>` for an installed runtime bundle, whose
`data.db` is separate even though it has the same document id. Jobs survive
restarts and stay with their records. A queue created before `store_key`
existed is rebuilt in place on open; its rows move to the Studio queue of
their document.

| Column | Meaning |
|---|---|
| `status` | `queued`, `running`, `succeeded`, `failed`, or `cancelled` |
| `idempotency_key` | unique per store key. Enqueueing a duplicate returns the existing job |
| `attempts`, `max_attempts` | default 3 attempts |
| `backoff_ms`, `next_run_at` | retry delay `backoff · 2^(attempts − 1)`, default 1 s, capped at 1 hour |
| `lease_until` | a claimed job's lease, default 5 minutes |
| `lease_token` | `<attempt>:<uuid>`, new on every claim |

`job_attempts` stores one row per attempt with start and finish times, the
outcome, the error, and the step log.

A claim runs in an `IMMEDIATE` transaction. It picks the oldest due `queued`
job, marks it `running`, and sets the lease, so two workers cannot claim the
same job. A job whose lease expired, because the app crashed or quit mid-run,
goes back to `queued` on the next claim or start. Cancel and retry are
explicit commands. `complete_job` and `fail_job` take the claim's lease token
and check it, with `status = 'running'`, in one `IMMEDIATE` transaction. A
worker whose lease expired, or whose job was cancelled and claimed again, gets
`STALE_LEASE` and its result is ignored.

The default idempotency key combines the trigger id, table, record identity,
event, a hash of the record values, and the write id that `records.ts` gives
each write call (`meta.writeId`). It dedupes retries of the same write only; a
later identical write is a new event. A trigger can supply its own key as an
expression instead.

### The worker

`src/automation/worker.ts` polls `claim_next_job` for the open document and
runs the action through the same `runAction` the UI uses. It runs with a
headless context, where navigation, confirmation, and form state fail with a
clear message. It reports `complete_job` or `fail_job` with the step log.

## Consequences

- Jobs persist across restarts but run only while ixtable is open. Users see
  queued jobs waiting until they reopen the app.
- Delivery is at least once. A crash after the action's writes but before
  `complete_job` runs the job again after the lease expires. Actions that must
  not repeat need an idempotent design or a key that a second run detects.
- Sync trigger failures surface to the user, but they do not undo the
  initiating write.
- Actions run in TypeScript, so the queue needs the app's frontend. A Rust-only
  worker would need a second action runner, which this design avoids.

## Evidence

- `src-tauri/src/jobs.rs` tests: idempotent enqueue per store, atomic and
  exclusive claims, exponential backoff until failed, completion with log,
  cancel and retry, expired leases recovered after restart, stale lease tokens
  refused, separate Studio and runtime queues, v1 queue migration.
- `tests/unit/automation-triggers.test.ts`: sync triggers inside the write,
  old values on update, failure propagation, recursion depth limit.
- `tests/unit/automation-runner.test.ts`: step behavior, stop, continue, and
  rollback failure modes, headless contexts.
- `tests/integration/automation.test.tsx`: sync triggers, async triggers with
  retry after failure and cancel, deduplication by idempotency key, and
  rollback-mode actions as one RecordStore transaction.
