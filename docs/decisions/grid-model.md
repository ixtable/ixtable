# Shared grid model for forms and dashboards

Status: accepted for the model, the engine, and forms. Dashboard use is in
progress. Covers PRD §6.3, §13, and the Phase 0 grid spike.

## Context

Forms and dashboards both place items on a grid that the user resizes. The
PRD requires one grid system for both, serialized-layout tests that don't
depend on screenshots, and a model that a future non-browser renderer could
read. Storing CSS strings would tie every saved application to the browser.

## Decision

The persisted model describes the grid, and CSS is derived from it at render
time. Rust owns the serialized types in `src-tauri/src/design/mod.rs`, and
`src/grid/types.ts` mirrors them field for field.

- `GridLayout`: column and row tracks, column and row gaps, padding, item
  alignment, named regions, and breakpoints. The default is 12 `fr` columns
  with 16 px gaps.
- `GridTrack`: `fixed` in pixels, `content`, or `fr`, each with an optional
  minimum and maximum in pixels.
- `Placement`: 1-based column and row with spans, or a named region.
- `Breakpoint`: replacement column tracks for containers at least `minWidth`
  wide. Breakpoints are mobile first.

`src/grid/engine.ts` holds pure functions with no React or DOM access:
`layoutToCss`, `placementToCss`, `resolveBreakpoint`, `resolvePlacements`,
`resizePlacement`, `movePlacement`, `nextPlacement`, `detectOverlaps`,
`validateLayout`, and the `normalize*` helpers. Placements are always authored
against the base columns. When a breakpoint has fewer columns, items keep
their authored positions if they fit. Otherwise they reflow in reading order,
with spans clamped to the active column count.

`<GridCanvas>` and `<GridItem>` render a layout with CSS Grid. In edit mode
they add keyboard resizing with Alt+Arrow, moving with Alt+Shift+Arrow, and
labelled toolbar buttons. Per-item span limits come from the caller, so the
form designer can give each control kind its own limits.

Hidden items behave the same on forms and dashboards. When a control's or a
dashboard component's `visibleWhen` is false, the item is not rendered. The
other items keep their authored placement, so a hidden item leaves its cells
empty instead of pulling later items up. A `content` row with nothing in it
still collapses, as CSS Grid does. A dashboard component whose `enabledWhen`
is false stays in place, wrapped in a disabled fieldset that disables every
control inside it.

Rust validates layouts in `design::validate_layout` and `validate_span`. The
dashboard module calls the same functions, so a placement that overflows the
grid fails the same way in both. `validateLayout` in TypeScript returns the
same `Issue` shape, plus rendering warnings such as overlapping regions.

## Consequences

- A React Native or PDF renderer can read the same JSON without parsing CSS.
- Layout rules live in one engine. A form and a dashboard with the same
  layout render the same way.
- Two type definitions must stay in sync. The serialization tests check that
  `normalizeLayout` fills serde defaults in Rust field order and never
  persists derived CSS.
- Free positioning in pixels is out of scope. Every item sits on a track.

## Evidence

- `tests/unit/grid.test.ts`: track and container CSS, breakpoints, wrapping,
  named regions, resize and move limits, overlap detection, validation that
  mirrors the Rust errors, and serialization.
- `tests/unit/grid-canvas.test.tsx`: labelled resize buttons, keyboard resize
  and move within limits, breakpoint by measured width, pointer drag snapping.
- `src-tauri/src/design/tests.rs`: placements cannot overflow columns, and
  container children use the container grid.
- `tests/unit/dashboard-conditions.test.tsx`: a hidden dashboard component
  leaves the other components' placements unchanged.
- Dashboards: `src-tauri/src/dashboards.rs` reuses the design grid validators.
  Dashboard UI tests are in progress.
