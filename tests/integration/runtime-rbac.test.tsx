import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { createTable, insertRow, renderNewDocument, value } from "./helpers";

const LONG = { timeout: 20_000 };
type Placement = { column: number; columnSpan: number };
type Config = {
  design: {
    forms: Array<{ name: string; controls: Array<{ label: string; placement: Placement }> }>;
  };
  roles: Array<{ name: string }>;
};
const readConfig = () => invoke<Config>("read_document_config", { windowLabel: "main" });
const placementOf = async (form: string, label: string) =>
  (await readConfig()).design.forms
    .find((f) => f.name === form)
    ?.controls.find((c) => c.label === label)?.placement;

it("previews roles, hides navigation, blocks deletes, and shows fields conditionally", async () => {
  const user = await renderNewDocument();
  await createTable("customers", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT" },
    { name: "kind", declaredType: "TEXT" },
    { name: "vat", declaredType: "TEXT" },
  ]);
  await createTable("notes", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "body", declaredType: "TEXT" },
  ]);
  await insertRow("customers", [
    { column: "id", value: value("integer", 1) },
    { column: "name", value: value("text", "Acme") },
    { column: "kind", value: value("text", "company") },
    { column: "vat", value: value("text", "GB123") },
  ]);

  await user.click(screen.getByRole("button", { name: "Design" }));
  await screen.findByRole("region", { name: "Form builder" }, LONG);
  const table = screen.getByRole("combobox", { name: "Table to generate from" });
  await user.selectOptions(table, "notes");
  await user.click(screen.getByRole("button", { name: "Generate form from table" }));
  await screen.findByRole("button", { name: "Notes list" }, LONG);
  await user.selectOptions(table, "customers");
  await user.click(screen.getByRole("button", { name: "Generate form from table" }));
  await screen.findByRole("button", { name: "Customers list" }, LONG);
  await user.click(await screen.findByRole("group", { name: "Vat" }, LONG));
  const properties = screen.getByRole("complementary", { name: "Properties" });
  fireEvent.change(within(properties).getByRole("textbox", { name: "Visible when" }), {
    target: { value: "record.kind = 'company'" },
  });
  const name = screen.getByRole("group", { name: "Name" });
  name.focus();
  await user.keyboard("{Enter}");
  await user.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  await waitFor(
    async () => expect((await placementOf("Customers", "Name"))?.columnSpan).toBe(5),
    LONG,
  );
  await user.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(
    async () => expect((await placementOf("Customers", "Name"))?.columnSpan).toBe(6),
    LONG,
  );
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(await screen.findByRole("tab", { name: "Roles" }, LONG));
  expect(await screen.findByText(/not a database security boundary/, {}, LONG)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "New role" }));
  const roleName = await screen.findByRole("textbox", { name: "Role name" }, LONG);
  await user.clear(roleName);
  await user.type(roleName, "Clerk");
  await user.click(screen.getByRole("checkbox", { name: "read form Customers list" }));
  await user.click(screen.getByRole("checkbox", { name: "update form Customers" }));
  await user.click(screen.getByRole("checkbox", { name: "Show Customers in navigation" }));
  await waitFor(
    async () => expect((await readConfig()).roles.map((r) => r.name)).toEqual(["Clerk"]),
    LONG,
  );
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const nav = await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
  expect(within(nav).getByRole("button", { name: "Notes" })).toBeInTheDocument();
  await user.click(within(nav).getByRole("button", { name: "Customers" }));
  const page = screen.getByRole("region", { name: "Application page" });
  await user.click(await within(page).findByRole("row", { name: "Open 1" }, LONG));
  const detail = await within(page).findByRole("form", { name: "Customers" }, LONG);
  expect(await within(detail).findByRole("textbox", { name: "Vat" }, LONG)).toHaveValue("GB123");
  expect(within(detail).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  await user.click(within(detail).getByRole("button", { name: "Edit" }));
  const edit = await within(page).findByRole("form", { name: "Edit Customers" }, LONG);
  const kind = await within(edit).findByDisplayValue("company", {}, LONG);
  await user.clear(kind);
  await user.type(kind, "person");
  await waitFor(() => expect(within(edit).queryByRole("textbox", { name: "Vat" })).toBeNull());
  await user.click(within(edit).getByRole("button", { name: "Cancel" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Preview as role" }), "Clerk");
  await waitFor(() => expect(within(nav).queryByRole("button", { name: "Notes" })).toBeNull());
  const row = await within(page).findByRole("row", { name: "Open 1" }, LONG);
  expect(within(page).queryByRole("button", { name: "New customers" })).toBeNull();
  await user.click(row);
  const clerkView = await within(page).findByRole("form", { name: "Customers" }, LONG);
  expect(await within(clerkView).findByRole("button", { name: "Edit" }, LONG)).toBeInTheDocument();
  expect(within(clerkView).queryByRole("button", { name: "Delete" })).toBeNull();
});
