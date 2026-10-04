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

it("groups by a non-output column with an aggregate over a multi-condition outer join", async () => {
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
  await user.selectOptions(screen.getByRole("combobox", { name: "Join type for c" }), "left");
  await user.click(screen.getByRole("button", { name: "Add condition to c" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Join c left column 2" }),
    "o.customer_id",
  );
  await user.selectOptions(screen.getByRole("combobox", { name: "Join c right column 2" }), "id");
  await user.click(await screen.findByRole("checkbox", { name: "c.name" }, LONG));
  await user.click(screen.getByRole("checkbox", { name: "o.amount" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Aggregate for o.amount" }), "sum");
  await user.type(screen.getByRole("textbox", { name: "Alias for o.amount" }), "total");
  await user.click(screen.getByRole("checkbox", { name: "c.id" }));
  await user.click(screen.getByRole("checkbox", { name: "Output c.id" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Group by column" }), "c.id");
  await user.click(screen.getByRole("button", { name: "Add group by" }));
  expect(screen.getByRole("list", { name: "Group by columns" })).toHaveTextContent("c.id");
  await user.click(screen.getByRole("button", { name: "Add sort" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Sort 1 field" }), "c.id");
  await user.selectOptions(screen.getByRole("combobox", { name: "Sort 1 direction" }), "desc");

  const preview = await screen.findByRole("region", { name: "Preview" }, LONG);
  await waitFor(() => {
    const rows = within(preview).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual([
      "Harbor & Pine",
      "Juniper Supply",
      "Northstar Goods",
    ]);
  }, LONG);
  await captureDocument(document, {
    name: "query-03-group-by-multi-join",
    expand: ".query-tab-panel",
    expectations: [
      "The customers join is a Left join with two ON conditions listed under it.",
      "The Group by panel lists c.id (selected but not output) and o.amount is summed as total.",
      "The preview lists Harbor & Pine, Juniper Supply, then Northstar Goods with their totals.",
    ],
  });
  await user.click(screen.getByRole("tab", { name: "SQL" }));
  const sql = screen.getByLabelText("Generated SQL");
  expect(sql).toHaveTextContent(
    'LEFT JOIN "customers" AS "c" ON "o"."customer_id" = "c"."id" AND "o"."customer_id" = "c"."id"',
  );
  expect(sql).toHaveTextContent('GROUP BY "c"."id", "c"."name"');
  await captureDocument(document, {
    name: "query-04-group-by-sql",
    expectations: [
      "The SQL shows a LEFT JOIN with two AND-ed conditions, GROUP BY c.id, c.name, and ORDER BY c.id DESC.",
    ],
  });
});
