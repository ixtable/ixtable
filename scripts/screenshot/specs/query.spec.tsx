import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { captureDocument } from "../capture";
import { LONG, openMode, renderNewDocument, seedSales } from "./fixtures";

it("builds a joined, grouped query with a parameter in the visual builder", async () => {
  const user = await renderNewDocument();
  await seedSales();
  await openMode(user, "Query");
  await screen.findByRole("heading", { name: "Query" }, LONG);
  await user.click(screen.getByRole("button", { name: "New query" }));

  await user.selectOptions(await screen.findByRole("combobox", { name: "Source table" }), "orders");
  await user.click(
    await screen.findByRole(
      "button",
      { name: "Join customers on o.customer_id = customers.id" },
      LONG,
    ),
  );
  await user.click(await screen.findByRole("checkbox", { name: "c.name" }, LONG));
  await user.click(screen.getByRole("checkbox", { name: "o.amount" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Aggregate for o.amount" }), "sum");
  await user.type(screen.getByRole("textbox", { name: "Alias for o.amount" }), "total");
  await user.click(screen.getByRole("button", { name: "Add row count" }));
  await user.type(screen.getByRole("textbox", { name: "Alias for Row count" }), "orders");

  await user.type(screen.getByRole("textbox", { name: "New parameter name" }), "min_amount");
  await user.click(screen.getByRole("button", { name: "Add parameter" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Type of min_amount" }), "number");
  await user.type(screen.getByRole("textbox", { name: "Default for min_amount" }), "50");
  await user.click(screen.getByRole("button", { name: "Add filter" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Filter 1 column" }), "o.amount");
  await user.selectOptions(screen.getByRole("combobox", { name: "Filter 1 operator" }), ">=");
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Filter 1 compares with" }),
    "param",
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Filter 1 parameter" }),
    "min_amount",
  );
  await user.click(screen.getByRole("button", { name: "Add sort" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Sort 1 field" }), "sum(o.amount)");
  await user.selectOptions(screen.getByRole("combobox", { name: "Sort 1 direction" }), "desc");
  const name = screen.getByRole("textbox", { name: "Query name" });
  await user.clear(name);
  await user.type(name, "Customer totals");

  const preview = await screen.findByRole("region", { name: "Preview" }, LONG);
  // Orders of at least 50, summed per customer, largest first.
  await waitFor(() => {
    const rows = within(preview).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual([
      "Northstar Goods",
      "Harbor & Pine",
      "Juniper Supply",
    ]);
  }, LONG);
  await captureDocument(document, {
    name: "query-01-builder",
    expand: ".query-tab-panel",
    expectations: [
      "The builder shows orders joined to customers with the selected fields, sum, and row count.",
      "The min_amount parameter, the amount filter that uses it, and the sort are listed.",
      "The live preview below lists one row per customer.",
    ],
  });

  await user.click(screen.getByRole("tab", { name: "SQL" }));
  expect(screen.getByLabelText("Generated SQL")).toHaveTextContent('"o"."amount" >= $min_amount');
  await captureDocument(document, {
    name: "query-02-generated-sql",
    expectations: [
      "The SQL tab shows the generated SELECT with the join, GROUP BY, and $min_amount filter.",
    ],
  });
  await user.click(screen.getByRole("tab", { name: "Builder" }));
  await user.click(screen.getByRole("button", { name: "Save query" }));
  expect(await screen.findByRole("button", { name: "Customer totals" }, LONG)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
