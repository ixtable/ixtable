# PRD: Expressions, Actions & Triggers

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Provide constrained declarative business logic and local automation without introducing a general-purpose scripting platform.

## Common principles

Expressions, actions, and triggers are versioned application objects with stable IDs.

They must be:

- serializable;
- deterministic for the same inputs where specified;
- reference-validatable;
- permission-aware;
- inspectable in Studio;
- safe to execute without filesystem/process/general network access.

## Expression language

Expressions support:

- validation;
- computed values;
- filters;
- formatting;
- conditional visibility;
- conditional enabled state;
- action/trigger conditions.

## Expression type system

The evaluator must define semantics for:

- null;
- boolean;
- text;
- integer/numeric;
- date;
- time;
- date-time;
- list/record values only where explicitly supported.

Required rules:

- no implicit truthiness for arbitrary values;
- null propagation/coalescing behavior is explicit;
- numeric coercion/precision follows the logical type contract;
- date/time functions define timezone assumptions;
- equality/comparison semantics are fixture-tested.

## Expression context

An expression sees only explicitly supplied namespaces, for example:

- current record;
- form draft values;
- query parameters;
- current runtime user/role metadata allowed by RBAC;
- action inputs;
- constants/built-in functions.

No ambient filesystem, environment variable, process, arbitrary database connection, or arbitrary network access is available.

## Built-in functions

Functions use a versioned allowlist.

Function categories may include:

- boolean/logical;
- text;
- numeric;
- date/time;
- null handling;
- safe formatting.

Non-deterministic functions such as current time/randomness must be explicitly identified because they affect validation, testing, caching, and report reproducibility.

## Actions

An action is a declarative ordered graph/list of supported steps.

MVP action steps may include:

- create record;
- update record;
- delete record;
- navigate/open object;
- set form/runtime state;
- execute/read an approved saved query;
- export/print;
- show confirmation/message;
- conditionally execute/branch;
- invoke another action only with bounded recursion rules.

## Action transaction semantics

Record mutations inside one action must declare whether they require one transaction.

Default for a bounded sequence of mutations against one RecordStore should be atomic when the backend supports it.

Non-transactional side effects must not be presented as rollback-safe.

An action result is success only when all required synchronous steps complete.

After successful mutation, dependent DuckDB reads refresh before the UI treats the action as completed where the updated data is immediately shown.

## Triggers

MVP trigger events are:

- record created;
- record updated.

Trigger definitions include:

- stable trigger ID;
- target entity/table;
- event;
- optional condition expression;
- action target;
- execution class;
- recursion/idempotency policy metadata.

## Synchronous triggers

Synchronous triggers participate in the initiating mutation workflow.

The implementation must define whether each trigger runs:

- inside the same transaction; or
- immediately after commit.

That choice must be explicit because failure semantics differ.

For transaction-safe record-only trigger actions, same-transaction execution is preferred where feasible.

A synchronous trigger failure must never be silently converted into success.

## Asynchronous local queue

Async triggers enqueue durable local jobs.

Each job records:

- stable job ID;
- trigger/action identity and definition version;
- relevant record identity/input snapshot;
- created time;
- attempt count;
- next retry time;
- status;
- last error;
- idempotency key where required.

Queue requirements:

- survives application/process restart;
- bounded concurrency;
- bounded retry/backoff;
- manual retry/cancel where appropriate;
- history visible to the developer/runtime user subject to permissions;
- poison jobs do not block unrelated jobs forever.

## Definition-version behavior

Queued async work must not accidentally execute arbitrary new semantics after an application update.

The system must either:

- bind queued jobs to the action/trigger definition version they were created with; or
- explicitly migrate/cancel incompatible queued jobs during update.

This must be testable.

## Recursion and loop protection

Protect against:

- trigger updates same record → retriggers itself;
- action A invokes B invokes A;
- cascades that exceed bounded depth.

The runtime tracks execution lineage/depth and fails with an actionable loop error.

A developer may not disable all loop protection.

## Permissions

Authorization applies to:

- user-invoked actions;
- objects accessed by actions;
- mutations produced by actions/triggers.

The execution principal for trigger work must be explicit. Async jobs must not become a privilege-escalation path after the initiating user loses authorization.

## Observability

Action/trigger history records:

- object IDs;
- timestamps;
- outcome;
- normalized errors;
- safe execution context metadata.

Protected credentials/secret values are redacted.

## Acceptance criteria

- Expression fixtures define deterministic type/null/comparison semantics.
- Invalid references/functions fail publish/export validation.
- One-action atomic mutations roll back together where atomicity is promised.
- UI never reports an action complete before required mutation/read refresh completes.
- Synchronous trigger failure follows its documented transaction/commit semantics.
- Async jobs survive restart and respect retry/cancel state.
- Queued work has deterministic behavior across application definition updates.
- Trigger/action recursion is bounded and produces actionable errors.
- Revoked/unauthorized principals cannot gain access through deferred trigger execution.
- Logs/history contain no protected credential values.

## Non-goals

- JavaScript/TypeScript/Python/Lua scripting in MVP;
- arbitrary filesystem/process/network APIs;
- schedules;
- webhooks;
- always-on cloud automation;
- arbitrary integration marketplace.
