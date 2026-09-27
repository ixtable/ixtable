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

## Expression surfaces

ixtable intentionally uses two related expression surfaces:

1. **SQL expressions** inside saved DuckDB queries for data filtering, projection, aggregation, grouping, and other relational calculations.
2. **Common application expressions** for UI/business-rule contexts that are not database rows: form validation, computed UI values, visibility/enabled state, report application-level calculations, dashboard interaction rules, and action/trigger conditions.

The common application language uses familiar SQL-like operators/functions where practical, but it is a constrained language parsed into a typed AST rather than arbitrary SQL execution. It cannot open tables or execute statements. This preserves SQL familiarity without coupling UI state to a database engine.

## Common expression engine

The common engine is one typed parser/validator/evaluator reused by forms, reports, dashboards, actions, and triggers. Each expression is parsed and validated before Runtime execution; runtime does not repeatedly interpret unchecked ad hoc strings.

Expressions reference stable object/field identities behind readable author-facing syntax so renames can be handled safely.

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

`now()`/current-time access is allowed but marks an expression explicitly nondeterministic. Randomness is not implicitly deterministic and requires an explicitly supported function if ever exposed. Nondeterministic expressions affect caching/testing/report reproducibility and must be tracked as such.

## Actions

An action is a declarative ordered sequence with conditional branches; MVP does not require a general workflow-graph editor.

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

Default for a bounded sequence of mutations against one RecordStore is atomic when the backend supports it. Actions may contain sequential steps targeting multiple RecordStores, but each store's transaction is independent and the action must never present the overall multi-store operation as atomic.

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

Transaction-safe record-only synchronous trigger actions run inside the originating RecordStore transaction in MVP.

A synchronous trigger failure must never be silently converted into success.

## Asynchronous local queue

Async triggers enqueue durable jobs in an installation-local SQLite queue.

Each queued job preserves the initiating user/principal identity and the relevant permission context, then rechecks current authorization at execution time. Deferred work must not continue solely because an old permission snapshot once allowed it.

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
- bounded exponential retry/backoff with a terminal failed/dead-letter state;
- manual retry/cancel where appropriate;
- history visible to the developer/runtime user subject to permissions;
- poison jobs do not block unrelated jobs forever.

## Definition-version behavior

Queued async work must not accidentally execute arbitrary new semantics after an application update.

Queued jobs are pinned to the action/trigger definition version they were created with. Application update packaging must retain the executable declarative definition needed by pending compatible jobs, or explicitly cancel jobs that cannot be retained safely.

This must be testable.

## Recursion and loop protection

Protect against:

- trigger updates same record → retriggers itself;
- action A invokes B invokes A;
- cascades that exceed bounded depth.

Actions may invoke other actions. The runtime tracks execution lineage/depth for both action-to-action calls and trigger cascades and enforces a hard configurable product maximum; unlimited recursion is never allowed.

A developer may not disable all loop protection.

## Prohibited side effects in MVP

Actions/triggers do not expose arbitrary network/HTTP requests or arbitrary filesystem APIs in MVP. Export/print operations remain the bounded product capabilities already defined elsewhere.

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

- SQL remains the expression surface for relational query calculations, while UI/business-rule expressions use the common typed SQL-like AST evaluator.
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
