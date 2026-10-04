# Expression language

Status: accepted. Covers PRD §17.1. The user-facing reference is
[`src/expr/README.md`](../../src/expr/README.md).

## Context

Validation rules, computed values, show and enable conditions, filters,
formatting, action conditions, and report totals all need small formulas. The
PRD excludes arbitrary JavaScript. The formulas run inside the app and read
record data, so they must not reach the DOM, the network, or host functions.
They must also give the same answer on every machine, whatever its time zone
or locale.

## Decision

ixtable has one declarative, Access-style expression language, implemented
once in TypeScript under `src/expr/`. A hand-written parser in `parser.ts`
produces an AST, and a tree-walking evaluator in `evaluate.ts` runs it against
an explicit scope object. There is no `eval`, no `Function`, and no prototype
access. Names like `constructor` and `__proto__` are rejected, and inherited
or function-valued properties read as null.

Rust never evaluates expressions. It stores them as strings in
`DocumentConfig`, and config validation only flags empty ones. Every consumer,
including forms, the runtime, reports, dashboards, and the automation runner,
imports the same `parse`, `evaluate`, `evaluateBoolean`, and `check`.

Semantics chosen for determinism:

- SQL three-valued logic for null. Where a true or false answer is needed,
  null counts as false.
- `&` joins text. `+` on text is a type error.
- Arithmetic results round to 15 significant digits, so `0.1 + 0.2` is `0.3`.
  Division by zero gives null.
- Dates are ISO strings, and all date math runs in UTC. Tests pass the clock
  through `evaluate(src, scope, { now })`.
- Text comparison is by character code, with no locale.
- `regexmatch` rejects patterns that can backtrack for minutes, and caps
  pattern and input length.

Scope roots follow one convention across features: `record`, `form`, `app`,
`params`, `rows`, and `value`. `check(src, knownNames)` reports unknown names
with character positions, so editors can flag them as the user types.

## Consequences

- One implementation means a filter in a dashboard and the same filter in an
  action behave the same.
- Rust-side validation cannot catch an expression's syntax errors. The form,
  report, and automation editors run `check` on every keystroke and show the
  diagnostics next to the field.
- Expressions only see data the caller puts in scope. Adding a capability,
  such as a lookup function, is a language change with tests, not a plugin.
- Expressions cannot run SQL. Queries stay in the DuckDB read path with bound
  parameters.

## Evidence

- `tests/unit/expr.test.ts`: literals and arithmetic, names, null semantics,
  comparisons, functions, aggregates, dates, formatting, errors, injection
  attempts, `check`, and `referencedNames`.
- Consumers use the shared module in `src/automation`, `src/runtime`,
  `src/reports/engine`, and `src/dashboards`, and their tests run real
  expressions: `tests/unit/automation-runner.test.ts`,
  `tests/unit/forms-state.test.ts`, and `tests/unit/report-engine.test.ts`.
