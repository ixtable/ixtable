import { screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { vi } from "vitest";
import { createTable, insertRow, readPage, renderNewDocument, value } from "./helpers";

it("renders a typed table and persists sorted CRUD mutations", async () => {
  await renderNewDocument();
  await createTable("people", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT", nullable: false },
    { name: "score", declaredType: "REAL" },
  ]);
  await insertRow("people", [
    { column: "id", value: value("integer", 2) },
    { column: "name", value: value("text", "Beta") },
    { column: "score", value: value("real", 2.5) },
  ]);
  await insertRow("people", [
    { column: "id", value: value("integer", 1) },
    { column: "name", value: value("text", "Alpha") },
    { column: "score", value: value("null") },
  ]);
  const ascending = await readPage("people", [{ column: "name", descending: false }]);
  expect(ascending.rows.map((row) => row[1])).toEqual([
    value("text", "Alpha"),
    value("text", "Beta"),
  ]);
  await invoke("update_row", {
    windowLabel: "main",
    table: "people",
    values: [{ column: "name", value: value("text", "Alpha updated") }],
    identity: [value("integer", 1)],
  });
  expect((await readPage("people")).rows[0][1]).toEqual(value("text", "Alpha updated"));
  await invoke("delete_row", {
    windowLabel: "main",
    table: "people",
    identity: [value("integer", 2)],
  });
  expect((await readPage("people")).total).toBe(1);
  expect(screen.getAllByText("people").length).toBeGreaterThan(0);
});

it("reports invalid typed input without partially inserting a row", async () => {
  const user = await renderNewDocument();
  await createTable("items", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "label", declaredType: "TEXT", nullable: false },
  ]);
  await user.type(await screen.findByRole("textbox", { name: "New id" }), "not-a-number");
  await user.type(screen.getByRole("textbox", { name: "New label" }), "bad");
  await user.click(screen.getByRole("button", { name: "Insert row" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("id requires an integer");
  expect((await readPage("items")).total).toBe(0);
});

it("designs a selected table with typed alterations and destructive confirmation", async () => {
  const user = await renderNewDocument();
  await createTable("inventory", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "label", declaredType: "TEXT" },
  ]);

  await user.click(await screen.findByRole("button", { name: "Design table" }));
  const tableName = screen.getByLabelText("Table name");
  await user.clear(tableName);
  await user.type(tableName, "products");
  await user.click(screen.getByRole("button", { name: "Rename table" }));
  // Await the designer closing so metadata and selection have both settled.
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Design inventory" })).toBeNull(),
  );
  expect(await screen.findByRole("button", { name: /^products\b/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await user.click(screen.getByRole("button", { name: "Design table" }));
  const labelName = await screen.findByRole(
    "textbox",
    { name: "New name for label" },
    { timeout: 20_000 },
  );
  await user.clear(labelName);
  await user.type(labelName, "title");
  await user.click(screen.getByRole("button", { name: "Rename column label" }));

  await user.click(await screen.findByRole("button", { name: "Design table" }));
  await user.type(
    await screen.findByRole("textbox", { name: "New column name" }, { timeout: 20_000 }),
    "price",
  );
  await user.selectOptions(screen.getByRole("combobox", { name: "New column type" }), "REAL");
  await user.click(screen.getByRole("button", { name: "Add column" }));
  expect((await readPage("products")).columns.map((column) => column.name)).toEqual([
    "id",
    "title",
    "price",
  ]);

  await user.click(await screen.findByRole("button", { name: "Design table" }));
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(await screen.findByRole("button", { name: "Drop price" }, { timeout: 20_000 }));
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("permanently deletes its data"));
  expect((await readPage("products")).columns).toHaveLength(3);
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Drop price" }));
  expect((await readPage("products")).columns.map((column) => column.name)).toEqual([
    "id",
    "title",
  ]);
  confirm.mockRestore();
});
