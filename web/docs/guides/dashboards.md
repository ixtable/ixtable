---
sidebar_position: 4
---

# Dashboards

_Dashboards arrange numbers, charts, tables, forms, reports, filters, and buttons on the same grid that forms use._

A dashboard is a page of components that read saved queries. Filters at the top pass values to the queries' parameters, so one choice of region or date range updates every chart on the page. Open Dashboards mode in Studio and choose **New dashboard**. The **Design** tab edits the layout, and the **View** tab shows the dashboard with live data.

## The grid

Dashboards use the same grid as forms. By default it has 12 equal columns with 16 pixel gaps, and each row is 120 pixels high. With no component selected, **Dashboard grid** in the settings panel changes the column count, gaps, padding, alignment, track sizes, named regions, and breakpoints. A breakpoint changes the column count at a minimum window width, and components wrap to fit.

New components go in the first free space. Drag a component's corner to resize it, or use Alt and the arrow keys. Alt, Shift, and the arrow keys move it. The problems list under the canvas flags overlapping components and missing references.

## Components

| Component | Shows |
| --- | --- |
| KPI | One number from a query, with an optional comparison |
| Chart | A bar, line, area, pie, donut, scatter, or summary chart of a query |
| Table | Query rows in pages, with an optional row filter and conditional styles |
| Filter | One of the dashboard's filters, placed on the grid |
| Form | A form in one of its modes, showing a record |
| Report | A report preview that follows the dashboard's filters |
| Action button | A button that runs an [action](./automation) |
| Text | Plain text. Blank lines separate paragraphs |

Every component has a **Title** and two [expressions](../reference/expressions), **Visible when** and **Enabled when**. They read the filter values as `params` and the application state as `app`. A disabled component is grayed out and ignores input. These conditions control presentation only. Use [roles](./roles) to restrict access.

## KPIs

A KPI reads a saved query. **Value field** shows a column from the first row. A **Value expression** such as `sum(rows.amount)` works over all rows and takes priority over the field. The optional **Comparison** shows the difference between the value and a second field or expression, such as `▲ 12 vs target`. **Format** takes a number pattern such as `#,##0.00`.

## Charts

Pick a saved query and a **Chart type**, then the **X field** and one or more **Value fields**. Each value field is a series.

- **Group by** splits the first value field into one series per value of another column.
- **Stacked** stacks bar and area series.
- Rows with the same X value are added together. To show an average or a count, compute it in the query.
- A chart shows up to 8 series or slices and folds the rest into "Other".
- Pie and donut charts use the first series.
- Scatter charts need numbers on both axes and skip other rows.
- A summary chart shows the latest value, its change from the previous value, and a sparkline.

Hovering over a bar or point shows its value. Each chart also includes a data table for screen readers.

## Filters

With no component selected, the **Filters** section of the settings panel defines the dashboard's filters. A filter sets a query parameter, and every component query that declares a parameter with the same name receives the value.

| Control | Sets |
| --- | --- |
| Drop-down list | One value from a fixed list or from the first column of a query. "All" clears it |
| Text box | Text |
| Number | A number |
| Date | A date |
| Date range | Two parameters, `<name>From` and `<name>To` |

A blank filter passes null, so the query's own default applies. A filter can have a default value. Filters you do not place on the grid appear in a toolbar above the dashboard. The problems list warns about a filter whose parameter no query uses, and about a required query parameter that no filter sets.

## Refresh

The dashboard runs each distinct query once when it opens, and components that share a query share the result. Queries run again a moment after a filter changes, after any record is saved in the application, and when you choose **Refresh**. There is no timed refresh. When queries take more than two seconds, a progress strip offers **Cancel queries**.

## Dashboards in the Runtime

A navigation item can open a dashboard in the Runtime. An action's Open dashboard step can open one with parameter values, which become the initial filter values. An action button on a dashboard cannot set form state. In Studio's View tab, a button that navigates shows a note instead, because navigation happens only in the Runtime.

A role needs read access to open a dashboard. That grant also lets the role read the queries behind the dashboard's KPIs, charts, tables, and filter choices. Each embedded form and report needs its own read grant, and each button needs the right to run its action. [Roles and permissions](./roles) explains the grants.

Filters and table columns shape what the dashboard shows. They do not hide data from a role. A role that can read a query can read every row and column it returns, so grant a narrower query when a role must see less.

## Next steps

- [Queries](./queries)
- [Reports](./reports)
- [Design view](../concepts/design-view)
