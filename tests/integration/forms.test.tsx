import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { insertRow, readPage, refreshDatabase, renderNewDocument, value } from "./helpers";

const LONG = { timeout: 20_000 };

type Column = {
  name: string;
  declaredType: string;
  nullable?: boolean;
  primaryKeyPosition?: number;
};
async function createTableWithKeys(
  name: string,
  columns: Column[],
  foreignKeys: Array<{ columns: string[]; targetTable: string; targetColumns: string[] }> = [],
) {
  await invoke("create_database_table", {
    windowLabel: "main",
    spec: {
      name,
      columns: columns.map((column) => ({
        nullable: true,
        primaryKeyPosition: 0,
        unique: false,
        defaultExpression: null,
        generatedExpression: null,
        ...column,
      })),
      foreignKeys: foreignKeys.map((fk) => ({ ...fk, onUpdate: null, onDelete: null })),
      checks: [],
      withoutRowid: false,
    },
  });
}

async function salesSchema() {
  await createTableWithKeys("customers", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT", nullable: false },
  ]);
  await createTableWithKeys(
    "orders",
    [
      { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
      { name: "customer_id", declaredType: "INTEGER", nullable: false },
      { name: "note", declaredType: "TEXT" },
      { name: "qty", declaredType: "INTEGER" },
    ],
    [{ columns: ["customer_id"], targetTable: "customers", targetColumns: ["id"] }],
  );
  await createTableWithKeys(
    "order_items",
    [
      { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
      { name: "order_id", declaredType: "INTEGER" },
      { name: "product", declaredType: "TEXT" },
      { name: "quantity", declaredType: "INTEGER" },
    ],
    [{ columns: ["order_id"], targetTable: "orders", targetColumns: ["id"] }],
  );
  for (const [id, name] of [
    [1, "Acme"],
    [2, "Globex"],
  ] as const)
    await insertRow("customers", [
      { column: "id", value: value("integer", id) },
      { column: "name", value: value("text", name) },
    ]);
  await refreshDatabase();
  await screen.findByRole("button", { name: /^order_items\b/ }, LONG);
}

it("generates CRUD forms, validates, creates, edits, and manages related records at runtime", async () => {
  const user = await renderNewDocument();
  await salesSchema();

  await user.click(screen.getByRole("button", { name: "Design" }));
  await screen.findByRole("region", { name: "Form builder" }, LONG);
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Table to generate from" }),
    "orders",
  );
  await user.click(screen.getByRole("button", { name: "Generate form from table" }));
  const forms = screen.getByRole("region", { name: "Forms" });
  expect(
    await within(forms).findByRole("button", { name: "Orders list" }, LONG),
  ).toBeInTheDocument();
  expect(within(forms).getByRole("button", { name: "Orders" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(await screen.findByRole("group", { name: "Qty" }, LONG));
  const properties = screen.getByRole("complementary", { name: "Properties" });
  const rule = within(properties).getByRole("textbox", { name: "Validation rule" });
  await user.type(rule, "value >");
  await waitFor(() => expect(rule).toHaveAttribute("aria-invalid", "true"));
  await user.type(rule, " 0");
  await waitFor(() => expect(rule).not.toHaveAttribute("aria-invalid"));
  await user.type(
    within(properties).getByRole("textbox", { name: "Error message" }),
    "Quantity must be positive.",
  );
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const page = await screen.findByRole("region", { name: "Application page" }, LONG);
  const appNav = screen.getByRole("navigation", { name: "Application navigation" });
  await user.click(within(appNav).getByRole("button", { name: "Orders" }));
  expect(within(appNav).getByRole("button", { name: "Orders" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await user.click(await within(page).findByRole("button", { name: "New orders" }, LONG));
  const create = await screen.findByRole("form", { name: "New Orders" }, LONG);
  await user.click(within(create).getByRole("button", { name: "Create" }));
  expect(await within(create).findByText("Customer is required.")).toBeInTheDocument();
  const customer = within(create).getByRole("combobox", { name: "Customer" });
  await within(customer).findByRole("option", { name: "Globex" }, LONG);
  await user.type(within(create).getByRole("searchbox", { name: "Search Customer" }), "Ac");
  await waitFor(
    () => expect(within(customer).queryByRole("option", { name: "Globex" })).toBeNull(),
    LONG,
  );
  await user.selectOptions(customer, "Acme");
  await user.type(within(create).getByRole("spinbutton", { name: "Qty" }), "-1");
  await user.tab();
  expect(await within(create).findByText("Quantity must be positive.")).toBeInTheDocument();
  await user.clear(within(create).getByRole("spinbutton", { name: "Qty" }));
  await user.type(within(create).getByRole("spinbutton", { name: "Qty" }), "3");
  await user.type(within(create).getByRole("textbox", { name: "Note" }), "Rush");
  await user.click(within(create).getByRole("button", { name: "Create" }));

  const detail = await screen.findByRole("form", { name: "Orders" }, LONG);
  await waitFor(async () => {
    const orders = await readPage("orders");
    expect(orders.rows.map((row) => row.map((cell) => cell.value))).toEqual([[1, 1, "Rush", 3]]);
  });
  expect(await within(detail).findByDisplayValue("Acme", {}, LONG)).toBeInTheDocument();
  await user.click(within(detail).getByRole("button", { name: "Edit" }));
  const edit = await screen.findByRole("form", { name: "Edit Orders" }, LONG);
  await within(edit).findByDisplayValue("Rush", {}, LONG);
  await user.clear(within(edit).getByRole("textbox", { name: "Note" }));
  await user.type(within(edit).getByRole("textbox", { name: "Note" }), "Normal");
  await user.click(within(edit).getByRole("button", { name: "Save" }));
  await screen.findByRole("form", { name: "Orders" }, LONG);
  await waitFor(async () => expect((await readPage("orders")).rows[0][2].value).toBe("Normal"));
  const items = await screen.findByRole("region", { name: "Order items" }, LONG);
  await user.click(await within(items).findByRole("button", { name: "Add order items" }, LONG));
  const child = await within(items).findByRole("form", { name: "New Order items" }, LONG);
  expect(within(child).queryByRole("region", { name: /Order items/ })).toBeNull();
  await user.type(within(child).getByRole("textbox", { name: "Product" }), "Widget");
  await user.type(within(child).getByRole("spinbutton", { name: "Quantity" }), "2");
  await user.click(within(child).getByRole("button", { name: "Create" }));
  expect(await within(items).findByRole("cell", { name: "Widget" }, LONG)).toBeInTheDocument();
  expect((await readPage("order_items")).rows[0].map((cell) => cell.value)).toEqual([
    1,
    1,
    "Widget",
    2,
  ]);

  await user.click(within(items).getByRole("button", { name: "Edit order items row 1" }));
  const childEdit = await within(items).findByRole("form", { name: "Edit Order items" }, LONG);
  const quantity = await within(childEdit).findByRole("spinbutton", { name: "Quantity" }, LONG);
  await waitFor(() => expect(quantity).toHaveValue(2), LONG);
  await user.clear(quantity);
  await user.type(quantity, "5");
  await user.click(within(childEdit).getByRole("button", { name: "Save" }));
  expect(await within(items).findByRole("cell", { name: "5" }, LONG)).toBeInTheDocument();

  await user.click(within(items).getByRole("button", { name: "Delete order items row 1" }));
  await user.click(await screen.findByRole("button", { name: "Confirm" }));
  expect(await within(items).findByText("No order items yet.", {}, LONG)).toBeInTheDocument();
  expect((await readPage("order_items")).total).toBe(0);
  await user.click(within(page).getByRole("button", { name: "Back to Orders list" }));
  expect(await within(page).findByRole("row", { name: "Open 1" }, LONG)).toBeInTheDocument();
});
