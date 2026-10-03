import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
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

it("designs a selected table with staged alterations and an impact preview for drops", async () => {
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
  const labelName = screen.getByRole("textbox", { name: "Column label name" });
  await user.clear(labelName);
  await user.type(labelName, "title");
  await user.click(screen.getByRole("button", { name: "Stage changes to label" }));
  await user.type(screen.getByRole("textbox", { name: "New column name" }), "price");
  await user.selectOptions(screen.getByRole("combobox", { name: "New column type" }), "real");
  await user.click(screen.getByRole("button", { name: "Add column" }));
  const pending = screen.getByRole("region", { name: "Pending changes" });
  await waitFor(() => expect(within(pending).getAllByText("Changes in place")).toHaveLength(3), {
    timeout: 20_000,
  });
  await user.click(within(pending).getByRole("button", { name: "Apply changes" }));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Design inventory" })).toBeNull(),
  );
  expect(await screen.findByRole("button", { name: /^products\b/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect((await readPage("products")).columns.map((column) => column.name)).toEqual([
    "id",
    "title",
    "price",
  ]);

  await user.click(await screen.findByRole("button", { name: "Design table" }));
  await user.click(await screen.findByRole("button", { name: "Drop price" }, { timeout: 20_000 }));
  await user.click(screen.getByRole("button", { name: "Apply changes" }));
  const dialog = await screen.findByRole("dialog", {}, { timeout: 20_000 });
  expect(within(dialog).getByText("Destructive")).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect((await readPage("products")).columns).toHaveLength(3);
  await user.click(screen.getByRole("button", { name: "Apply changes" }));
  const again = await screen.findByRole("dialog", {}, { timeout: 20_000 });
  await user.click(within(again).getByRole("checkbox"));
  await user.click(within(again).getByRole("button", { name: "Apply changes" }));
  await waitFor(async () =>
    expect((await readPage("products")).columns.map((column) => column.name)).toEqual([
      "id",
      "title",
    ]),
  );
});
