import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { captureDocument } from "../capture";
import { LONG, refreshDatabase, renderNewDocument, seedSales } from "./fixtures";

type Schema = {
  primaryKey: string[];
  foreignKeys: Array<{ targetTable: string }>;
  uniques: unknown[];
  checks: unknown[];
  indexes: Array<{ name: string }>;
};
const inspect = (table: string) => invoke<Schema>("inspect_table", { windowLabel: "main", table });

it("models a table with keys, a relationship, constraints, and an index", async () => {
  const user = await renderNewDocument();
  await seedSales();

  await user.click(screen.getByRole("button", { name: "New table" }));
  const form = await screen.findByRole("form", { name: "Create table" }, LONG);
  await user.type(within(form).getByLabelText("Table name"), "shipments");
  const first = within(form).getByRole("textbox", { name: "Column 1 name" });
  await user.clear(first);
  await user.type(first, "order_id");
  await user.selectOptions(
    within(form).getByRole("combobox", { name: "Column 1 type" }),
    "integer",
  );
  const second = within(form).getByRole("textbox", { name: "Column 2 name" });
  await user.clear(second);
  await user.type(second, "parcel");
  await user.selectOptions(
    within(form).getByRole("combobox", { name: "Column 2 type" }),
    "integer",
  );
  await user.click(within(form).getByRole("checkbox", { name: "Column 2 primary key" }));
  await user.click(within(form).getByRole("button", { name: "Add column" }));
  await user.type(within(form).getByRole("textbox", { name: "Column 3 name" }), "tracking");
  await user.click(within(form).getByRole("checkbox", { name: "Column 3 unique" }));
  await user.click(within(form).getByRole("button", { name: "Add column" }));
  await user.type(within(form).getByRole("textbox", { name: "Column 4 name" }), "weight");
  await user.selectOptions(
    within(form).getByRole("combobox", { name: "Column 4 type" }),
    "decimal",
  );
  await user.click(within(form).getByRole("checkbox", { name: "Relationship columns: order_id" }));
  await user.selectOptions(within(form).getByRole("combobox", { name: "Target table" }), "orders");
  await user.selectOptions(
    within(form).getByRole("combobox", { name: "Target column for order_id" }),
    "id",
  );
  await user.selectOptions(within(form).getByRole("combobox", { name: "On delete" }), "CASCADE");
  await user.click(within(form).getByRole("button", { name: "Add relationship" }));
  await user.type(within(form).getByRole("textbox", { name: "Check expression" }), "weight > 0");
  await user.click(within(form).getByRole("button", { name: "Add check" }));
  await user.type(within(form).getByRole("textbox", { name: "Index name" }), "by_tracking");
  await user.click(within(form).getByRole("checkbox", { name: "Index columns: tracking" }));
  await user.click(within(form).getByRole("button", { name: "Add index" }));
  await captureDocument(document, {
    name: "schema-01-create-table",
    expand: ".table-designer",
    expectations: [
      "The Create table form lists four typed columns with key, required, and unique toggles.",
      "The staged relationship, check, and index appear in their sections before creation.",
    ],
  });

  await user.click(within(form).getByRole("button", { name: "Create table" }));
  expect(await screen.findByRole("button", { name: /^shipments\b/ }, LONG)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const schema = await inspect("shipments");
  expect(schema.primaryKey).toEqual(["order_id", "parcel"]);
  expect(schema.foreignKeys.map((fk) => fk.targetTable)).toEqual(["orders"]);
  expect(schema.indexes.map((index) => index.name)).toContain("by_tracking");

  await user.click(screen.getByRole("button", { name: /^orders\b/ }));
  await user.click(await screen.findByRole("button", { name: "Design table" }, LONG));
  await screen.findByRole("heading", { name: "Design orders" }, LONG);
  await user.type(screen.getByRole("textbox", { name: "New column name" }), "due_on");
  await user.click(screen.getByRole("button", { name: "Add column" }));
  await user.click(screen.getByRole("checkbox", { name: "Column note required" }));
  await user.click(screen.getByRole("button", { name: "Stage changes to note" }));
  const pending = screen.getByRole("region", { name: "Pending changes" });
  await within(pending).findByText("Requires table rebuild", {}, LONG);
  await captureDocument(document, {
    name: "schema-02-table-designer",
    expand: ".table-designer",
    expectations: [
      "The designer shows the orders columns with type, required, unique, and default controls.",
      "Pending changes label the in-place column add and the rebuild for the required change.",
    ],
  });

  await user.click(within(pending).getByRole("button", { name: "Apply changes" }));
  const dialog = await screen.findByRole("dialog", {}, LONG);
  expect(within(dialog).getByRole("button", { name: "Apply changes" })).toBeDisabled();
  await captureDocument(document, {
    name: "schema-03-impact-preview",
    expectations: [
      "The impact preview dialog lists affected rows and dependent tables.",
      "Generated SQL is visible and Apply stays disabled until the risk is acknowledged.",
    ],
  });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Close" }));

  await refreshDatabase();
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(4));
  await captureDocument(document, {
    name: "schema-04-relationships",
    selector: ".flow-browser",
    viewport: { width: 1440, height: 900 },
    expectations: [
      "All four tables appear with their key and foreign-key fields marked.",
      "Edges connect orders to customers, order_items to orders, and shipments to orders.",
      "Tables sit in dependency columns (customers, then orders, then order_items and shipments), so no edge runs behind a table.",
    ],
  });
});
