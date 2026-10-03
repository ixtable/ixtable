import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { captureDocument } from "../capture";
import { LONG, openMode, renderNewDocument, seedSales } from "./fixtures";

type Placement = { column: number; row: number; columnSpan: number; rowSpan: number };
type Config = {
  design: {
    forms: Array<{ name: string; controls: Array<{ label: string; placement: Placement }> }>;
  };
};
const placementOf = async (form: string, label: string) =>
  (await invoke<Config>("read_document_config", { windowLabel: "main" })).design.forms
    .find((f) => f.name === form)
    ?.controls.find((c) => c.label === label)?.placement;

it("generates a CRUD form, designs it on the grid, and runs it with validation and master/detail", async () => {
  const user = await renderNewDocument();
  await seedSales();

  // Studio: generate list + detail forms for orders and their customers lookup.
  await openMode(user, "Design");
  await screen.findByRole("region", { name: "Form builder" }, LONG);
  const source = screen.getByRole("combobox", { name: "Table to generate from" });
  await user.selectOptions(source, "customers");
  await user.click(screen.getByRole("button", { name: "Generate form from table" }));
  await screen.findByRole("button", { name: "Customers list" }, LONG);
  await user.selectOptions(source, "orders");
  await user.click(screen.getByRole("button", { name: "Generate form from table" }));
  const forms = screen.getByRole("region", { name: "Forms" });
  await within(forms).findByRole("button", { name: "Orders list" }, LONG);

  // Resize Amount on the shared grid with the keyboard, then add a validation rule.
  const amount = await screen.findByRole("group", { name: "Amount" }, LONG);
  const before = await placementOf("Orders", "Amount");
  amount.focus();
  await user.keyboard("{Enter}");
  await user.keyboard("{Alt>}{ArrowLeft}{ArrowLeft}{/Alt}");
  await waitFor(async () => {
    expect((await placementOf("Orders", "Amount"))?.columnSpan).toBe((before?.columnSpan ?? 0) - 2);
  }, LONG);
  const properties = screen.getByRole("complementary", { name: "Properties" });
  await user.type(
    within(properties).getByRole("textbox", { name: "Validation rule" }),
    "value > 0",
  );
  await user.type(
    within(properties).getByRole("textbox", { name: "Error message" }),
    "Amount must be positive.",
  );
  await captureDocument(document, {
    name: "forms-01-designer",
    expectations: [
      "The generated Orders form shows its controls as cards on the 12-column grid.",
      "The selected Amount card is highlighted, narrower than its neighbours, and shows resize handles.",
      "The Properties panel shows the Amount validation rule and error message.",
    ],
  });

  // Runtime: list, create with validation, relationship selector.
  await openMode(user, "Runtime");
  const page = await screen.findByRole("region", { name: "Application page" }, LONG);
  const nav = screen.getByRole("navigation", { name: "Application navigation" });
  await user.click(within(nav).getByRole("button", { name: "Orders" }));
  await within(page).findByRole("row", { name: "Open 1" }, LONG);
  // Foreign keys show the related record's name once the lookup query returns.
  await within(page).findAllByRole("cell", { name: "Northstar Goods" }, LONG);
  await captureDocument(document, {
    name: "runtime-01-list",
    expectations: [
      "The Runtime navigation lists Customers and Orders with Orders current.",
      "The Orders list shows five records with customer names instead of raw ids.",
    ],
  });

  await user.click(within(page).getByRole("button", { name: "New orders" }));
  const create = await screen.findByRole("form", { name: "New Orders" }, LONG);
  const customer = within(create).getByRole("combobox", { name: "Customer" });
  await within(customer).findByRole("option", { name: "Juniper Supply" }, LONG);
  await user.type(within(create).getByRole("spinbutton", { name: "Amount" }), "-5");
  await user.click(within(create).getByRole("button", { name: "Create" }));
  expect(await within(create).findByText("Customer is required.")).toBeInTheDocument();
  expect(await within(create).findByText("Amount must be positive.")).toBeInTheDocument();
  await captureDocument(document, {
    name: "runtime-02-create-validation",
    expectations: [
      "The New Orders form shows a searchable Customer relationship selector.",
      "Required and rule validation messages appear under Customer and Amount.",
    ],
  });

  await user.selectOptions(customer, "Juniper Supply");
  const amountInput = within(create).getByRole("spinbutton", { name: "Amount" });
  await user.clear(amountInput);
  await user.type(amountInput, "99");
  await user.type(within(create).getByRole("textbox", { name: "Status" }), "open");
  await user.click(within(create).getByRole("button", { name: "Create" }));

  // Master/detail: the created order shows its related items list.
  const detail = await screen.findByRole("form", { name: "Orders" }, LONG);
  expect(await within(detail).findByDisplayValue("Juniper Supply", {}, LONG)).toBeInTheDocument();
  const items = await screen.findByRole("region", { name: "Order items" }, LONG);
  await user.click(await within(items).findByRole("button", { name: "Add order items" }, LONG));
  const child = await within(items).findByRole("form", { name: "New Order items" }, LONG);
  await user.type(within(child).getByRole("textbox", { name: "Product" }), "Stoneware mug");
  await user.type(within(child).getByRole("spinbutton", { name: "Quantity" }), "4");
  await user.click(within(child).getByRole("button", { name: "Create" }));
  expect(await within(items).findByRole("cell", { name: "Stoneware mug" }, LONG)).toBeVisible();
  await captureDocument(document, {
    name: "runtime-03-master-detail",
    expectations: [
      "The saved order's detail view shows Juniper Supply, amount 99, and Edit/Delete actions.",
      "The Order items related list shows the new Stoneware mug row with edit and delete buttons.",
    ],
  });

  await user.click(within(detail).getByRole("button", { name: "Edit" }));
  const edit = await screen.findByRole("form", { name: "Edit Orders" }, LONG);
  const note = await within(edit).findByRole("textbox", { name: "Note" });
  await user.type(note, "Call before delivery");
  await captureDocument(document, {
    name: "runtime-04-edit",
    expectations: ["The Edit Orders form is prefilled and shows Save and Cancel actions."],
  });
  await user.click(within(edit).getByRole("button", { name: "Save" }));
  await screen.findByRole("form", { name: "Orders" }, LONG);
});
