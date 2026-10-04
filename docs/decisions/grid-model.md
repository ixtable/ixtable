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
labelled toolbar buttons. Per-item span limits come from the caller:
`controlConstraints` in `src/design/constraints.ts` gives each form control kind
a minimum width (for example 1 column for a yes/no field, 4 for sections and tab
groups, 6 for related lists on a 12-column grid, scaled to the grid's column
count) and caps every kind at the full width. The designer canvas, the runtime
form body, and the span fields in the properties panel all use it. Dashboards
use `constraintsFor` in `src/dashboards/model.ts` the same way.

`<LayoutSettings>` (`src/design/LayoutSettings.tsx`) is the one grid editor for
forms, form containers, and dashboards. It edits column and row tracks (kind,
size, minimum and maximum pixels), gaps, padding, item alignment, named regions,
and breakpoints. Changing the column count keeps the authored tracks and only
adds `1fr` tracks or removes tracks at the end. The form designer passes the
placed controls so `validateLayout` problems are listed under the settings. Each
item's properties offer a region picker (`RegionPicker`) when the grid has named
regions.

The editor never sends a layout the backend refuses, because one refused edit
blocks every later edit to the document until it is undone. Track sizes,
pixel limits, region names, and control positions are typed into a local draft
and applied on blur or Enter only when valid; the problem is shown next to the
input otherwise. Regions are clamped to the columns (`src/grid/regions.ts`), and
`LayoutSettings` drops any change that adds a `validateLayout` error. Renaming a
region renames every placement that uses it in the same update; removing a
region, or a column it no longer fits, clears or clamps it, and controls in a
removed region fall back to their column and row (`setLayout`, `withLayout`).

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
- `tests/unit/layout-settings.test.tsx`: track, alignment, and region editing,
  drafts that keep invalid values out, listed validation problems, and the
  region picker.
- `tests/unit/grid-regions.test.ts`: region clamping, renames, and cleared
  references in forms and dashboards.
- `tests/unit/form-constraints.test.ts`: per-kind form control limits.
- `tests/integration/form-grid-designer.test.tsx`: keyboard resizing stops at a
  control's limit, grid edits reach the saved definition, and renaming or
  removing a used region keeps the document saveable.
- `tests/unit/grid-canvas.test.tsx`: labelled resize buttons, keyboard resize
  and move within limits, breakpoint by measured width, pointer drag snapping.
- `src-tauri/src/design/tests.rs`: placements cannot overflow columns, and
  container children use the container grid.
- `tests/unit/dashboard-conditions.test.tsx`: a hidden dashboard component
  leaves the other components' placements unchanged.
- Dashboards: `src-tauri/src/dashboards.rs` reuses the design grid validators.
  Dashboard UI tests are in progress.
