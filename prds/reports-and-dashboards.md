# PRD: Reports, Charts & Dashboards

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Provide deterministic operational reporting and interactive dashboards without creating a second application framework or datasource layer.

## Shared data contract

Reports, charts, KPIs, and dashboard tables consume saved DuckDB-backed query results.

They must not:

- open RecordStore connections directly;
- define independent datasource credentials;
- bypass query parameter validation;
- mutate records except through embedded forms/actions.

## Reports

A report has:

- stable report ID;
- display name;
- saved-query data source(s);
- page configuration;
- versioned serialized layout;
- ordered visual/report bands;
- expressions/calculations.

### Supported components

MVP supports:

- static text;
- bound fields;
- images/application assets;
- lines and rectangles;
- query-backed tables;
- grouping;
- totals/calculated expressions;
- report header/footer;
- page header/footer;
- explicit pagination controls.

### Page model

The report definition uses renderer-neutral physical page concepts:

- page size;
- orientation;
- margins;
- content bounds;
- deterministic units;
- overflow/page-break rules.

Do not persist arbitrary browser CSS as the report contract.

The implementation must define one canonical measurement unit and conversion policy for screen preview, printer, and PDF output.

### Pagination

Pagination must be deterministic for identical:

- report definition;
- dataset;
- font assets/metrics;
- renderer version;
- page settings.

Rules must be explicit for:

- table row splitting;
- group keep-together behavior;
- repeated headers;
- orphan/widow-like group behavior where supported;
- oversized indivisible content;
- explicit page breaks.

Unsupported impossible layout requests produce validation/render errors rather than silent clipping.

### Fonts and images

Built-in report fonts must be controlled/pinned sufficiently for repeatable pagination.

Application-provided images use the attachment/asset contract and are decoded safely.

Platform-native font substitution must not silently change golden pagination.

### Outputs

- Studio/runtime preview;
- print;
- PDF.

PDF output is a first-class deterministic artifact, not a screenshot of the UI.

## Calculations

Report calculations use the common expression engine.

Supported scopes must be explicit, such as:

- row;
- group;
- page where deterministic;
- report total.

A calculation must not execute arbitrary code.

## Dashboards

Dashboards use the shared grid layout from the forms PRD.

Supported components include:

- KPI/summary value;
- data table;
- filter control;
- embedded form;
- action button;
- bar chart;
- line chart;
- area chart;
- pie/donut chart;
- scatter chart;
- summary visualization.

## Dashboard state

Dashboard filter/input state is runtime state, not persisted application definition unless the developer explicitly defines defaults.

Filters map to typed saved-query parameters.

Changing filter state:

1. validates/coerces input;
2. cancels obsolete in-flight requests where practical;
3. reruns dependent queries;
4. updates all dependent components consistently.

A dashboard must not create a second ad hoc query/state graph independent of application object dependencies.

## Charts

Charts consume tabular query output and define:

- query stable ID;
- parameter bindings;
- field mappings;
- aggregation expectation if not already in query output;
- presentation options supported by the built-in chart schema.

Complex data transformation belongs in the query, not hidden chart-specific SQL.

## Reuse rule

Dashboards reuse:

- shared grid;
- saved queries;
- form/table primitives;
- expressions;
- actions;
- permissions;
- common loading/error state.

A dashboard-only layout, permission, action, or datasource engine is prohibited.

## Error/loading states

Every report/dashboard data component has explicit:

- loading;
- empty;
- query error;
- cancelled;
- permission denied

behavior.

One failed dashboard component should not necessarily destroy unrelated components unless they share a required dependency.

## Acceptance criteria

- Golden report fixtures produce stable pagination/PDF output within declared tolerances on all supported platforms.
- Same data and report definition yield stable group/page totals.
- PDF generation is not dependent on viewport dimensions.
- Oversized/unsupported report constructs fail visibly rather than clipping silently.
- Dashboard filters use typed query parameters and update all declared dependents.
- Obsolete dashboard query results do not overwrite newer filter-state results.
- Forms embedded in dashboards behave identically to forms elsewhere.
- Chart components contain no independent datasource credentials/SQL mutation path.
- Report/dashboard authorization is enforced when invoked directly, not only through navigation.

## Non-goals

- nested subreports;
- report scripting;
- arbitrary HTML/CSS;
- barcode/label-specialized authoring;
- arbitrary custom chart plugins;
- separate dashboard datasource/runtime engines.
