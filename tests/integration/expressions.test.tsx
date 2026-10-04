import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { insertRow, refreshDatabase, renderNewDocument, value } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };

type Column = { name: string; declaredType: string; primaryKeyPosition?: number };
async function table(
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
const int = (n: number) => value("integer", n);
const txt = (s: string) => value("text", s);

async function seed() {
  await table("customers", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT" },
    { name: "active", declaredType: "INTEGER" },
  ]);
  await table(
    "orders",
    [
      { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
      { name: "customer_id", declaredType: "INTEGER" },
      { name: "qty", declaredType: "INTEGER" },
    ],
    [{ columns: ["customer_id"], targetTable: "customers", targetColumns: ["id"] }],
  );
  await table(
    "order_items",
    [
      { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
      { name: "order_id", declaredType: "INTEGER" },
      { name: "product", declaredType: "TEXT" },
      { name: "quantity", declaredType: "INTEGER" },
    ],
    [{ columns: ["order_id"], targetTable: "orders", targetColumns: ["id"] }],
  );
  for (const [id, name, active] of [
    [1, "Acme", 1],
    [2, "Globex", 0],
    [3, "Initech", 1],
  ] as const)
    await insertRow("customers", [
      { column: "id", value: int(id) },
      { column: "name", value: txt(name) },
      { column: "active", value: int(active) },
    ]);
  for (const [id, qty] of [
    [1, 2],
    [2, 9],
    [3, 0],
  ] as const)
    await insertRow("orders", [
      { column: "id", value: int(id) },
      { column: "customer_id", value: int(1) },
      { column: "qty", value: int(qty) },
    ]);
  for (const [id, product, quantity] of [
    [1, "Widget", 2],
    [2, "Gadget", 0],
  ] as const)
    await insertRow("order_items", [
      { column: "id", value: int(id) },
      { column: "order_id", value: int(1) },
      { column: "product", value: txt(product) },
      { column: "quantity", value: int(quantity) },
    ]);
  await refreshDatabase();
  await screen.findByRole("button", { name: /^order_items\b/ }, LONG);
}

it("applies designer-authored filters to a list form, a related list and a lookup, and styles cells", async () => {
  const user = await renderNewDocument();
  await seed();

  await user.click(screen.getByRole("button", { name: "Design" }));
  await screen.findByRole("region", { name: "Form builder" }, LONG);
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Table to generate from" }),
    "orders",
  );
  await user.click(screen.getByRole("button", { name: "Generate form from table" }));
  const forms = screen.getByRole("region", { name: "Forms" });
  await within(forms).findByRole("button", { name: "Orders list" }, LONG);
  const properties = screen.getByRole("complementary", { name: "Properties" });

  await user.click(await screen.findByRole("group", { name: "Qty" }, LONG));
  await user.click(within(properties).getByRole("button", { name: "Add style" }));
  const when = within(properties).getByRole("textbox", { name: "Style 1 when" });
  await user.type(when, "bogus > 5");
  await waitFor(() => expect(when).toHaveAttribute("aria-invalid", "true"));
  expect(within(properties).getByText("Unknown name 'bogus'")).toBeInTheDocument();
  await user.clear(when);
  await user.type(when, "value > 5");
  await waitFor(() => expect(when).not.toHaveAttribute("aria-invalid"));
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Style 1 tone" }),
    "negative",
  );

  await user.click(screen.getByRole("group", { name: "Customer" }));
  const choice = within(properties).getByRole("textbox", { name: "Choice filter" });
  await user.type(choice, "record.active = 1");
  await waitFor(() => expect(choice).not.toHaveAttribute("aria-invalid"));

  await user.click(screen.getByRole("group", { name: "Order items" }));
  const related = within(properties).getByRole("textbox", { name: "Row filter" });
  await user.type(related, "record.quantity > 0");

  await user.click(within(forms).getByRole("button", { name: "Orders list" }));
  const filter = await within(properties).findByRole("textbox", { name: "Row filter" }, LONG);
  await user.type(filter, "record.nope > 0");
  await waitFor(() => expect(filter).toHaveAttribute("aria-invalid", "true"));
  await user.clear(filter);
  await user.type(filter, "record.qty > 0");
  await waitFor(() => expect(filter).not.toHaveAttribute("aria-invalid"));

  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const page = await screen.findByRole("region", { name: "Application page" }, LONG);
  const appNav = screen.getByRole("navigation", { name: "Application navigation" });
  await user.click(within(appNav).getByRole("button", { name: "Orders" }));
  const list = await within(page).findByRole("region", { name: "Orders list" }, LONG);
  expect(await within(list).findByText("1–2 of 2", {}, LONG)).toBeInTheDocument();
  expect(within(list).queryByRole("row", { name: "Open 3" })).toBeNull();
  const nine = within(list).getByRole("cell", { name: "9" });
  expect(nine).toHaveClass("tone", "tone-negative");
  for (const cell of within(list).getAllByRole("cell", { name: "2" }))
    expect(cell).not.toHaveClass("tone");

  await user.click(within(list).getByRole("row", { name: "Open 1" }));
  const items = await screen.findByRole("region", { name: "Order items" }, LONG);
  expect(await within(items).findByRole("cell", { name: "Widget" }, LONG)).toBeInTheDocument();
  expect(within(items).queryByRole("cell", { name: "Gadget" })).toBeNull();

  const detail = await screen.findByRole("form", { name: "Orders" }, LONG);
  await user.click(within(detail).getByRole("button", { name: "Edit" }));
  const edit = await screen.findByRole("form", { name: "Edit Orders" }, LONG);
  const customer = await within(edit).findByRole("combobox", { name: "Customer" }, LONG);
  await within(customer).findByRole("option", { name: "Initech" }, LONG);
  expect(within(customer).queryByRole("option", { name: "Globex" })).toBeNull();
  const qty = within(edit).getByRole("spinbutton", { name: "Qty" });
  await user.clear(qty);
  await user.type(qty, "7");
  await waitFor(() => expect(qty.parentElement).toHaveClass("tone-negative"));
});

it("filters and styles a dashboard table and hides or disables components by filter value", async () => {
  const user = await renderNewDocument();
  await seed();
  const config = await invoke<Record<string, unknown>>("read_document_config", {
    windowLabel: "main",
  });
  config.savedQueries = [
    {
      id: "6d1f8e2a-0c39-4c55-9a4c-2b8f9f6f7a02",
      name: "Order sizes",
      sql: "SELECT id, qty FROM orders ORDER BY id",
      parameters: [],
    },
  ];
  await invoke("update_document_config", { windowLabel: "main", config });
  const archive = join(process.env.IXTABLE_STATE_DIR ?? "", "expressions.ixt");
  dialogMock.save.mockResolvedValueOnce(archive);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, LONG);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  dialogMock.open.mockResolvedValueOnce(archive);
  await user.click(await screen.findByRole("button", { name: /Open document/i }, LONG));
  await screen.findByText("Saved archive", {}, LONG);

  await user.click(screen.getByRole("button", { name: "Dashboards" }));
  const create = await screen.findByRole("button", { name: "New dashboard" }, LONG);
  await waitFor(() => expect(create).toBeEnabled(), LONG);
  await user.click(create);
  const properties = screen.getByRole("complementary", { name: "Properties" });

  await user.click(await screen.findByRole("button", { name: "Add table" }, LONG));
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Query" }),
    "Order sizes",
  );
  await within(properties).findByRole("checkbox", { name: "qty" }, LONG);
  const rowFilter = within(properties).getByRole("textbox", { name: "Row filter" });
  await user.type(rowFilter, "record.nope > 0");
  await waitFor(() => expect(rowFilter).toHaveAttribute("aria-invalid", "true"));
  await user.clear(rowFilter);
  await user.type(rowFilter, "record.qty > 0");
  await waitFor(() => expect(rowFilter).not.toHaveAttribute("aria-invalid"));
  await user.click(within(properties).getByRole("button", { name: "Add style" }));
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Style 1 column" }),
    "qty",
  );
  await user.type(within(properties).getByRole("textbox", { name: "Style 1 when" }), "value > 5");
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Style 1 tone" }),
    "warning",
  );
  await user.type(
    within(properties).getByRole("textbox", { name: "Enabled when" }),
    "isnull(params.size)",
  );

  await user.click(screen.getByRole("button", { name: "Add text" }));
  await user.type(within(properties).getByRole("textbox", { name: "Text" }), "Big orders only");
  const visible = within(properties).getByRole("textbox", { name: "Visible when" });
  await user.type(visible, "params.size = 'big'");
  await waitFor(() => expect(visible).not.toHaveAttribute("aria-invalid"));

  await user.click(within(properties).getByRole("button", { name: "Dashboard settings" }));
  await user.click(within(properties).getByRole("button", { name: "Add filter" }));
  const filter = within(properties).getByRole("group", { name: "Filter Filter" });
  await user.type(within(filter).getByRole("combobox", { name: "Parameter" }), "size");
  await user.clear(within(filter).getByRole("textbox", { name: "Filter name" }));
  await user.type(within(filter).getByRole("textbox", { name: "Filter name" }), "Size");
  await user.type(within(filter).getByRole("textbox", { name: "Choices" }), "big, small");

  await user.click(screen.getByRole("tab", { name: "View" }));
  const table = await screen.findByRole("region", { name: "Table 1" }, LONG);
  const nine = await within(table).findByRole("cell", { name: "9" }, LONG);
  expect(nine).toHaveClass("tone", "tone-warning");
  for (const cell of within(table).getAllByRole("cell", { name: "2" }))
    expect(cell).not.toHaveClass("tone");
  expect(within(table).queryByRole("cell", { name: "3" })).toBeNull();
  expect(within(table).queryByRole("cell", { name: "0" })).toBeNull();
  expect(table).not.toHaveAttribute("aria-disabled");
  expect(screen.queryByRole("region", { name: "Text 1" })).toBeNull();

  await user.selectOptions(await screen.findByRole("combobox", { name: "Size" }, LONG), "big");
  expect(await screen.findByRole("region", { name: "Text 1" }, LONG)).toHaveTextContent(
    "Big orders only",
  );
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "Table 1" })).toHaveAttribute(
      "aria-disabled",
      "true",
    ),
  );
});
