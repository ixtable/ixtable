import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { captureDocument } from "../capture";
import { LONG, openMode, renderNewDocument, saveAndReopen, saveQuery, seedSales } from "./fixtures";

it("builds a dashboard with a KPI, a bar chart, and a filter on the shared grid", async () => {
  const user = await renderNewDocument();
  await seedSales();
  await saveQuery(
    "Revenue by customer",
    "SELECT c.name AS customer, SUM(o.amount) AS revenue FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ($status IS NULL OR o.status = $status) GROUP BY c.name ORDER BY c.name",
    [{ name: "status", logicalType: "text", required: false }],
  );
  await saveAndReopen(user, "dashboard.ixt");

  await openMode(user, "Dashboards");
  const create = await screen.findByRole("button", { name: "New dashboard" }, LONG);
  await waitFor(() => expect(create).toBeEnabled(), LONG);
  await user.click(create);
  await user.click(await screen.findByRole("button", { name: "Add KPI" }, LONG));
  const properties = screen.getByRole("complementary", { name: "Properties" });
  const title = within(properties).getByRole("textbox", { name: "Title" });
  await user.clear(title);
  await user.type(title, "Revenue");
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Query" }),
    "Revenue by customer",
  );
  await user.type(
    within(properties).getByRole("textbox", { name: "Value expression" }),
    "sum(rows.revenue)",
  );
  await user.type(within(properties).getByRole("textbox", { name: "Format" }), "#,##0.00");
  await user.click(screen.getByRole("button", { name: "Add chart" }));
  const chartTitle = within(properties).getByRole("textbox", { name: "Title" });
  await user.clear(chartTitle);
  await user.type(chartTitle, "Revenue by customer");
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Query" }),
    "Revenue by customer",
  );
  const xField = within(properties).getByRole("combobox", { name: "X field" });
  await within(xField).findByRole("option", { name: "customer" }, LONG);
  await user.selectOptions(xField, "customer");
  await user.click(within(properties).getByRole("checkbox", { name: "revenue" }));
  await user.click(within(properties).getByRole("button", { name: "Dashboard settings" }));
  await user.click(within(properties).getByRole("button", { name: "Add filter" }));
  const filter = within(properties).getByRole("group", { name: /^Filter / });
  await user.type(
    within(filter).getByRole("textbox", { name: "Choices" }),
    "open, shipped, cancelled",
  );
  await captureDocument(document, {
    name: "dashboards-01-designer",
    expectations: [
      "The dashboard canvas shows the Revenue KPI and the chart as grid items in design mode.",
      "Dashboard settings list the status filter with its three choices.",
    ],
  });

  await user.click(screen.getByRole("tab", { name: "View" }));
  const kpi = await screen.findByRole("region", { name: "Revenue" }, LONG);
  expect(await within(kpi).findByText("965.50", {}, LONG)).toBeInTheDocument();
  await screen.findByRole("img", { name: /^Revenue by customer\. Bar chart/ }, LONG);
  await captureDocument(document, {
    name: "dashboards-02-view",
    expectations: [
      "The Revenue KPI reads 965.50 above a bar chart with one bar per customer.",
      "The status filter is shown above the components with no value selected.",
    ],
  });

  await user.selectOptions(screen.getByRole("combobox", { name: /status/i }), "open");
  expect(await within(kpi).findByText("195.50", {}, LONG)).toBeInTheDocument();
  await captureDocument(document, {
    name: "dashboards-03-filtered",
    expectations: [
      "With status = open the KPI reads 195.50 and the chart shows only Juniper Supply and Northstar Goods.",
    ],
  });
});

it("styles a table cell by condition and hides or disables components by filter value", async () => {
  const user = await renderNewDocument();
  await seedSales();
  await openMode(user, "Design");
  await user.selectOptions(
    await screen.findByRole("combobox", { name: "Table to generate from" }, LONG),
    "orders",
  );
  await user.click(screen.getByRole("button", { name: "Generate form from table" }));
  await within(screen.getByRole("region", { name: "Forms" })).findByRole(
    "button",
    { name: "Orders list" },
    LONG,
  );
  await saveQuery("Order amounts", "SELECT id, status, amount FROM orders ORDER BY id");
  await saveAndReopen(user, "conditions.ixt");

  await openMode(user, "Dashboards");
  const create = await screen.findByRole("button", { name: "New dashboard" }, LONG);
  await waitFor(() => expect(create).toBeEnabled(), LONG);
  await user.click(create);
  const properties = screen.getByRole("complementary", { name: "Properties" });
  await user.click(await screen.findByRole("button", { name: "Add table" }, LONG));
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Query" }),
    "Order amounts",
  );
  await within(properties).findByRole("checkbox", { name: "amount" }, LONG);
  const rowFilter = within(properties).getByRole("textbox", { name: "Row filter" });
  await user.type(rowFilter, "record.total > 0");
  await waitFor(() => expect(rowFilter).toHaveAttribute("aria-invalid", "true"), LONG);
  await captureDocument(document, {
    name: "dashboards-04-expression-error",
    expectations: [
      "The table's Row filter 'record.total > 0' is marked invalid with an inline error naming the unknown field.",
    ],
  });
  await user.clear(rowFilter);
  await user.type(rowFilter, "record.amount > 0");
  await waitFor(() => expect(rowFilter).not.toHaveAttribute("aria-invalid"), LONG);
  await user.click(within(properties).getByRole("button", { name: "Add style" }));
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Style 1 column" }),
    "amount",
  );
  await user.type(within(properties).getByRole("textbox", { name: "Style 1 when" }), "value > 300");
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Style 1 tone" }),
    "warning",
  );

  await user.click(screen.getByRole("button", { name: "Add form" }));
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Form" }),
    "Orders list",
  );
  await user.selectOptions(within(properties).getByRole("combobox", { name: "Form mode" }), "list");
  const enabled = within(properties).getByRole("textbox", { name: "Enabled when" });
  await user.type(enabled, "isnull(params.status)");
  await waitFor(() => expect(enabled).not.toHaveAttribute("aria-invalid"), LONG);

  await user.click(screen.getByRole("button", { name: "Add text" }));
  await user.type(
    within(properties).getByRole("textbox", { name: "Text" }),
    "Showing one status only",
  );
  const visible = within(properties).getByRole("textbox", { name: "Visible when" });
  await user.type(visible, "not(isnull(params.status))");
  await waitFor(() => expect(visible).not.toHaveAttribute("aria-invalid"), LONG);

  await user.click(within(properties).getByRole("button", { name: "Dashboard settings" }));
  await user.click(within(properties).getByRole("button", { name: "Add filter" }));
  const filter = within(properties).getByRole("group", { name: "Filter Filter" });
  await user.type(within(filter).getByRole("combobox", { name: "Parameter" }), "status");
  await user.clear(within(filter).getByRole("textbox", { name: "Filter name" }));
  await user.type(within(filter).getByRole("textbox", { name: "Filter name" }), "Status");
  await user.type(within(filter).getByRole("textbox", { name: "Choices" }), "open, shipped");

  await user.click(screen.getByRole("tab", { name: "View" }));
  const table = await screen.findByRole("region", { name: "Table 1" }, LONG);
  expect(await within(table).findByRole("cell", { name: "410" }, LONG)).toHaveClass(
    "tone",
    "tone-warning",
  );
  expect(within(table).getByRole("cell", { name: "120" })).not.toHaveClass("tone");
  const form = await screen.findByRole("region", { name: "Form 1" }, LONG);
  await within(form).findByRole("row", { name: "Open 1" }, LONG);
  expect(form).not.toHaveAttribute("aria-disabled");
  expect(screen.queryByRole("region", { name: "Text 1" })).toBeNull();
  await user.selectOptions(await screen.findByRole("combobox", { name: "Status" }, LONG), "open");
  expect(await screen.findByRole("region", { name: "Text 1" }, LONG)).toHaveTextContent(
    "Showing one status only",
  );
  await waitFor(
    () =>
      expect(screen.getByRole("region", { name: "Form 1" })).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    LONG,
  );
  await within(screen.getByRole("region", { name: "Form 1" })).findAllByRole(
    "cell",
    { name: "Northstar Goods" },
    LONG,
  );
  await captureDocument(document, {
    name: "dashboards-05-conditions",
    expectations: [
      "In the table, amounts above 300 (340, 410) carry a warning tone; smaller amounts are plain.",
      "With Status = open the 'Showing one status only' text appears and the embedded Orders list is greyed out as disabled, with a 'Not available right now.' note.",
      "The embedded Orders list shows customer names, not ids, and its New orders button fits inside the card.",
    ],
  });
});
