import { screen } from "@testing-library/react";
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
