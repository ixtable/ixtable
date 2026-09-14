# 0003. Shared grid schema and CSS Grid renderer

Status: accepted

Forms and dashboards serialize one layout model: tracks, gaps, padding, alignment, named regions, breakpoints, and 1-based placements. Track kinds are `fixed`, `content`, and `fr`. The schema stores numbers and enums. It does not store CSS strings.

The desktop renderer translates that model to CSS Grid (`display: grid`, `grid-template-*`, `minmax`, `grid-area`). Rust and TypeScript share the same fixture so a layout cannot drift between the archive validator and the Studio renderer.

A second dashboard-only layout engine is out of scope. Reports stay on the freeform band model in [0006](0006-report-pagination.md).

Proof lives in `css_grid_renderer_matches_canonical_fixture` and `tests/grid-css.test.ts`.
