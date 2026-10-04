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
`params`, `rows`, `value`, and `parent`. `check(src, knownNames)` reports
unknown names with character positions, so editors can flag them as the user
types. The table of roots per expression kind is in `src/expr/README.md`.

Filters and conditional styles (PRD §17.1) use the same evaluator through
`src/runtime/conditions.ts`:

- A filter is a boolean expression over one row as `record`. List forms,
  related lists, lookup selectors, and dashboard tables each store an optional
  `filter`. In a related list or lookup, `parent` is the record on screen.
  Rows are still read through DuckDB, and the filter runs on the fetched rows.
  Null, false, and evaluation errors drop the row. A syntax error is shown
  in place of the rows.
- Paging stays honest. A filtered list form reads its table in chunks of 500
  rows, once, up to 50,000 rows, and caches the matches per source, sort,
  search, filter, and filter inputs. Pages are slices of that cache, so paging
  never rescans and the pager total is the real match count. If the scan
  stopped at 50,000 rows, the list says "Filter applied to the first 50,000
  rows; some matches may be missing." A related list and a lookup scan until
  they fill their 200 or 50 rows. A dashboard table already holds the whole
  query result, so its page count is exact.
- A related list or lookup reloads only when a value its filter reads changes
  (`filterInputs` uses `referencedNames` to pick `parent.x`, `form.y`, and so
  on), debounced by 250 ms, so typing in other fields does not rescan.
- A conditional style is an ordered list of `{ id, when, tone }` rules on a
  form's input and computed controls, and `{ id, column, when, tone }` rules
  on a dashboard table. The first rule whose `when` is true sets the tone.
  List and related-list cells use the rules of the control bound to their
  column. Tones are names (`positive`, `negative`, `warning`, `muted`,
  `emphasis`) that map to `tone-*` classes, never raw CSS (PRD §6.3). Each tone
  has a non-color cue (a glyph, bold or italic text, or a border style), so it
  still reads in grayscale print and for color-blind users (PRD §27.4).
- Dashboard components have `visibleWhen` and `enabledWhen`, evaluated with
  the KPI scope (`params`, `app`) by the form helper `conditionResult()`. A
  condition that fails to evaluate keeps the component on screen with the
  error. A lookup whose filter does not parse shows the error under the
  selector. There is no dashboard-only state engine.
- `enabledWhen` is presentation, not access control (use roles for that). A
  disabled component is wrapped in a disabled, `inert` fieldset, and list rows
  ignore clicks and keys inside an inert container.

Rust stores these fields in `design` and `dashboards` and only flags empty
ones, and dashboard table style rules with no column, in validation. A tone
it does not know loads as `Tone::Other` and saves back unchanged.

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

- `tests/unit/conditions.test.ts`: first-match tones, row filters and their
  names, chunked scanning, cached full scans with truncation, pager text,
  filter inputs.
  `tests/unit/dashboard-conditions.test.tsx`: dashboard show/enable and table
  filter and styles. `tests/integration/expressions.test.tsx`: designer
  authoring and runtime results for list form, related list, lookup, and
  dashboard table filters and styles.
- `tests/unit/expr.test.ts`: literals and arithmetic, names, null semantics,
  comparisons, functions, aggregates, dates, formatting, errors, injection
  attempts, `check`, and `referencedNames`.
- Consumers use the shared module in `src/automation`, `src/runtime`,
  `src/reports/engine`, and `src/dashboards`, and their tests run real
  expressions: `tests/unit/automation-runner.test.ts`,
  `tests/unit/forms-state.test.ts`, and `tests/unit/report-engine.test.ts`.
