# PRD: Expressions, Actions & Triggers

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Provide constrained declarative behavior for business rules and local automation without introducing a general-purpose scripting platform.

## Expression language

Expressions support:

- validation;
- computed values;
- filters;
- formatting;
- conditional visibility;
- conditional enabled state;
- action conditions.

Requirements:

- deterministic evaluation;
- typed/null-aware semantics;
- explicit function allowlist;
- no filesystem/network/process access;
- clear errors with object/source context.

## Actions

Declarative actions may:

- create/update/delete records;
- navigate/open application objects;
- set form state;
- run approved queries;
- export/print where supported;
- chain bounded declarative steps;
- show confirmations/errors.

Mutations execute through the RecordStore, never DuckDB.

## Triggers

MVP supports local record-created and record-updated triggers.

Two execution classes:

- synchronous: participates in the user-visible mutation flow;
- asynchronous local queue: durable local job with retry/history/cancellation.

## Async queue

- persists across app restart;
- records attempt history;
- supports bounded retries/backoff;
- uses idempotency keys where side effects require them;
- exposes failure state to users;
- does not become an always-on cloud worker.

## Safety

- Prevent unbounded self-trigger loops.
- Publishing validates broken references and recursion risks.
- RBAC applies to actions/triggers invoked by runtime users.
- Trigger execution logs redact secrets.

## Acceptance criteria

- Equivalent expression fixtures produce deterministic results.
- Action failures do not leave partially applied transactions where atomicity is promised.
- Async jobs resume after restart.
- Trigger recursion is detected/bounded.
- Unauthorized users cannot invoke a permitted-looking UI action that targets a forbidden object.

## Non-goals

- JavaScript/TypeScript/Python/Lua scripting in MVP;
- schedules;
- webhooks;
- cloud automation workers;
- arbitrary integration marketplace.
