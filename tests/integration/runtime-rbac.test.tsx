import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { asTauriError } from "../../src/lib/api";
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
  const vat = await within(detail).findByRole("textbox", { name: "Vat" }, LONG);
  await waitFor(() => expect(vat).toHaveValue("GB123"), LONG);
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

  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => "OK",
      (error: unknown) => asTauriError(error).code,
    );
  const call = (command: string, args: Record<string, unknown>) =>
    code(invoke(command, { windowLabel: "main", ...args }));
  const tablePage = (table: string) =>
    call("read_table_page", { table, offset: 0, limit: 10, sorts: [], filters: [] });
  const note = [{ column: "body", value: value("text", "secret") }];
  await waitFor(async () => expect(await tablePage("notes")).toBe("FORBIDDEN"), LONG);
  expect(await call("insert_row", { table: "notes", values: note })).toBe("FORBIDDEN");
  expect(
    await call("execute_write_batch", { ops: [{ op: "insert", table: "notes", values: note }] }),
  ).toBe("FORBIDDEN");
  expect(await call("execute_read_query", { sql: "SELECT * FROM notes" })).toBe("FORBIDDEN");
  expect(await tablePage("customers")).toBe("OK");
  const identity = [value("integer", 1)];
  const rename = [{ column: "name", value: value("text", "Acme Ltd") }];
  const expected = [{ column: "name", value: value("text", "Acme") }];
  expect(await call("update_row", { table: "customers", values: rename, identity })).toBe(
    "EXPECTED_REQUIRED",
  );
  expect(await call("update_row", { table: "customers", values: rename, identity, expected })).toBe(
    "OK",
  );
  expect(await call("delete_row", { table: "customers", identity, expected })).toBe("FORBIDDEN");
  expect(await call("delete_row", { table: "customers", identity })).toBe("FORBIDDEN");
  expect(await call("insert_row", { table: "customers", values: rename })).toBe("FORBIDDEN");

  await user.selectOptions(
    screen.getByRole("combobox", { name: "Preview as role" }),
    "Developer (full access)",
  );
  await waitFor(async () => expect(await tablePage("notes")).toBe("OK"), LONG);
  await user.selectOptions(screen.getByRole("combobox", { name: "Preview as role" }), "Clerk");
  await waitFor(async () => expect(await tablePage("notes")).toBe("FORBIDDEN"), LONG);
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await waitFor(async () => expect(await tablePage("notes")).toBe("OK"), LONG);
  expect(await call("insert_row", { table: "notes", values: note })).toBe("OK");
});

it("checks query read access on paged saved queries like full runs", async () => {
  await renderNewDocument();
  await createTable("notes", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "body", declaredType: "TEXT" },
  ]);
  await insertRow("notes", [
    { column: "id", value: value("integer", 1) },
    { column: "body", value: value("text", "hello") },
  ]);
  const config = await invoke<Record<string, unknown>>("read_document_config", {
    windowLabel: "main",
  });
  const sql = "SELECT id, body FROM notes";
  config.savedQueries = [
    { id: "q-open", name: "Open notes", sql },
    { id: "q-secret", name: "Secret notes", sql },
  ];
  const grant = { kind: "query", id: "q-open", read: true };
  config.roles = [{ id: "clerk", name: "Clerk", permissions: { objects: [grant] } }];
  await invoke("update_document_config", { windowLabel: "main", config });
  const code = (command: string, args: Record<string, unknown>) =>
    invoke(command, { windowLabel: "main", runId: null, params: [], ...args }).then(
      () => "OK",
      (error: unknown) => asTauriError(error).code,
    );
  const page = (id: string) =>
    code("run_saved_query_page", { id, offset: 0, limit: 10, sorts: [], filters: [] });
  const run = (id: string) => code("run_saved_query", { id, limit: null });
  expect(await page("q-secret")).toBe("OK");
  await invoke("set_runtime_role_preview", { windowLabel: "main", roleId: "clerk" });
  expect(await page("q-open")).toBe("OK");
  expect(await run("q-open")).toBe("OK");
  expect(await page("q-secret")).toBe("FORBIDDEN");
  expect(await run("q-secret")).toBe("FORBIDDEN");
  await invoke("set_runtime_role_preview", { windowLabel: "main", roleId: null });
  expect(await page("q-secret")).toBe("OK");
});
