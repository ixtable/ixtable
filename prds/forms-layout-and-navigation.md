# PRD: Shared Grid, Forms & Navigation

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Provide one renderer-agnostic layout system for forms and dashboards, one form primitive system for generated and custom CRUD experiences, and one runtime navigation model.

## Design schema boundary

The shared layout/form/navigation model is a versioned nested schema inside `DocumentConfig`.

Its schema version is independent of the archive and top-level config versions.

The desktop renderer may use CSS Grid internally, but persisted definitions must remain renderer-neutral.

## Shared grid model

The canonical grid supports:

- ordered column and row tracks;
- fixed, content-sized, and fractional tracks;
- optional min/max constraints;
- row/column gaps;
- padding;
- row/column spans;
- item alignment;
- named regions;
- responsive breakpoints;
- constrained interactive resizing.

### Coordinate rules

- Serialized grid coordinates are 1-based.
- Spans must be positive.
- Placements may not exceed the declared column set for the active layout.
- Named-region references must resolve.
- Named regions are unique within their layout.
- Breakpoints are deterministic and may override layout properties explicitly defined by the schema; they are not arbitrary CSS media queries.

### Responsive rules

Breakpoint ordering and overlap behavior must be deterministic.

A layout must render predictably when:

- viewport width is below the first breakpoint;
- multiple breakpoint definitions could match;
- controls span tracks that change at a breakpoint;
- content exceeds available width.

The chosen precedence algorithm must be fixture-tested and documented in the schema implementation.

## Form model

A form has:

- stable form ID;
- display name;
- optional primary record source;
- shared grid layout;
- ordered controls;
- runtime mode capabilities;
- optional expressions/actions tied to supported events.

Supported MVP modes:

- list;
- detail;
- create;
- edit.

## Control primitives

MVP controls include at least:

- static text/label;
- text;
- number/decimal;
- boolean/checkbox;
- date;
- time;
- date-time where supported by logical type mapping;
- select;
- relationship selector;
- section/container;
- tabs;
- computed display;
- validation message;
- button/action;
- related-record list.

A control has stable identity within its form and a renderer-neutral placement.

## Data binding

Bindings are explicit and validated.

A bound control must resolve to one of:

- a writable RecordStore field for editable CRUD;
- a read-only query/result field;
- a computed expression;
- form/runtime state.

Binding definitions must distinguish writable from read-only sources.

For RecordStore-backed fields:

- table/field references must resolve against current schema metadata;
- schema rename/migration tooling must update or invalidate affected bindings explicitly;
- incompatible type/control combinations are validation errors.

For saved-query bindings:

- query stable ID is preferred over display name;
- result-field identity/alias behavior must be explicit;
- query-backed fields are read-only unless a separate action defines mutation.

## Form state and edit lifecycle

Edit/create forms use an explicit draft state.

Required behavior:

1. load current committed values;
2. maintain user edits separately from committed state until save;
3. run field/form validation;
4. execute one RecordStore mutation transaction when save is invoked;
5. run synchronous trigger behavior according to the automation PRD;
6. refresh DuckDB before dependent reads;
7. commit the form to clean state only after success.

Cancel discards unsaved form draft state, not previously committed records.

Dirty form state and dirty application-definition state are separate concepts.

## Validation

Validation may combine:

- control-local constraints;
- RecordStore schema constraints;
- expression-based rules.

Validation errors must map back to controls where possible.

Client-side validation improves UX but does not replace RecordStore constraint enforcement.

## Master/detail and related data

MVP supports one master/detail level.

Requirements:

- child relationship is based on declared schema relationships;
- creating a child binds the correct parent key;
- deleting/updating a parent respects RecordStore referential rules;
- detail refresh follows the DuckDB read-after-write contract.

Arbitrarily recursive/nested subforms are not supported.

## Generated CRUD

Generated CRUD is scaffolding, not a separate runtime.

Generated forms:

- use the same serialized schema;
- use the same controls;
- use the same bindings;
- may be edited immediately as ordinary forms;
- contain no hidden behavior unavailable to manually designed forms.

## Navigation

Applications define a navigation tree using stable application-object references.

Navigation entries may target:

- forms;
- dashboards;
- reports;
- approved actions.

Navigation supports label/icon/order/group metadata without making those values identity.

Runtime navigation is permission-filtered, but permission filtering is not the security boundary: direct object invocation must perform the same authorization checks.

## Studio/runtime parity

- Studio preview and Runtime use the same renderer primitives.
- Serialized layout tests are independent from screenshots.
- Preview must not silently support behaviors unavailable in Runtime.
- Runtime-only state cannot mutate application definitions.
- Keyboard access and visible focus are required for built-in controls.

## Acceptance criteria

- Grid fixtures serialize/deserialise without semantic drift.
- Invalid spans/regions/breakpoints fail schema validation.
- Responsive fixtures select deterministic layouts at boundary widths.
- Generated CRUD forms reopen as ordinary editable form definitions.
- Editable bindings mutate through RecordStore; query/computed bindings remain read-only.
- Form save does not become clean until mutation + required refresh succeeds.
- Cancel never rolls back an already committed record mutation.
- One-level master/detail creates and refreshes related rows correctly.
- Conditional visibility/enabled state reacts deterministically to expression changes.
- Permission-hidden navigation cannot be bypassed by direct object invocation.
- Same form fixture renders through Studio preview and Runtime without divergent feature behavior.

## Non-goals

- absolute pixel canvas for forms;
- arbitrary nested subforms;
- custom scripted controls;
- arbitrary CSS persisted in the application model;
- browser/mobile renderer in MVP.
