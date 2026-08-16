---
sidebar_position: 1
---

# Data view

_Data view puts project structure and record editing in one workspace._

Open Data view to see how tables relate before you change their records. The object browser, table browser, and records grid keep the current table in context.

![The full Data view workspace in ixtable](../assets/data-view.png)

## Object browser

The **object browser** groups tables, saved queries, and SQL scripts in the project sidebar. Select a table to make it active. Use the search field to narrow a larger project by object name.

Each table entry includes its record count. Queries and SQL scripts are visible in the current app, but their editors and execution flows are not implemented.

:::note TODO

Document query editing, SQL execution, and object creation when those actions are implemented.

:::

## Table browser

The **table browser** draws each table as a node with its fields. Primary and foreign keys show how records connect across the project. You can pan, zoom, and arrange the canvas while the records grid stays available below it.

Selecting `Orders` keeps the same table active in the object browser, relationship canvas, and records grid. That shared selection prevents the diagram and data editor from drifting into different contexts.

![Customers, Products, Orders, and Order Items connected in the table browser](../assets/data-view-canvas.png)

## Records grid

The **records grid** displays fields as columns and records as rows. Enter values in the final draft row to add a record without opening another screen.

![A new order entered in the final records-grid row](../assets/inline-record.png)

The screenshot shows a draft order with `ORD-10483` and `CUST-001`. The active row stays aligned with the fields above it so you can compare the new values with existing records.

:::note TODO

Document validation, persistence, sorting, filtering, and record deletion when those behaviors are implemented.

:::

## Ribbon commands

The ribbon groups actions by task. The current interface exposes table management and query setup commands, including Select, Make Table, Append, Update, Delete, Show Table, and Insert Rows.

These commands establish the intended workspace, but most do not run an operation yet.

:::note TODO

Implement and document each ribbon command. Add examples that show its effect on project data.

:::

## Next steps

- [Overview](/docs/)
- [Design view](./design-view)
- [Testing](./testing)
