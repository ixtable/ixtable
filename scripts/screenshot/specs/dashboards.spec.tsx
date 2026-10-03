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
