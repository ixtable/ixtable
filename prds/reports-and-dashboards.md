# PRD: Reports, Charts & Dashboards

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Provide deterministic operational reporting and interactive dashboards without creating a second application framework.

## Reports

The freeform report canvas supports:

- static text;
- bound fields;
- images;
- lines/rectangles;
- query-backed tables;
- grouping;
- totals/calculated expressions;
- report/page headers and footers;
- pagination controls.

Outputs:

- preview;
- print;
- PDF.

Report datasets come from saved DuckDB-backed queries.

## Determinism

The same report fixture and data must produce stable pagination and layout across supported platforms within declared tolerances.

Golden PDF/snapshot fixtures are release gates.

## Dashboards

Dashboards use the shared grid model and can contain:

- KPI values;
- tables;
- filters;
- forms;
- action buttons;
- bar/line/area charts;
- pie/donut charts;
- scatter charts;
- summary charts.

Charts consume query results; they do not define independent datasource access.

## Reuse rule

Dashboards must reuse existing:

- grid;
- query;
- form/table;
- expression;
- action;
- permission primitives.

A dashboard-only state or data engine is prohibited.

## Acceptance criteria

- Reports print/export to PDF deterministically for golden fixtures.
- Page/group totals match source query results.
- Dashboard filters update dependent datasets without bypassing query parameter rules.
- Forms embedded in dashboards behave identically to forms elsewhere.
- Unsupported report constructs fail validation before publish.

## Non-goals

- nested subreports;
- arbitrary HTML/CSS;
- report scripts;
- barcode/label-specialized tooling;
- custom visualization plugins in MVP.
