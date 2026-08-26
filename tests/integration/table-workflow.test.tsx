import { screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import {
  createTable,
  type DataValue,
  insertRow,
  readPage,
  renderNewDocument,
  value,
} from "./helpers";

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

it("filters typed values and applies stable multi-column pagination", async () => {
  await renderNewDocument();
  await createTable("events", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "label", declaredType: "TEXT" },
    { name: "score", declaredType: "REAL" },
    { name: "enabled", declaredType: "BOOLEAN" },
    { name: "happened", declaredType: "DATE" },
  ]);
  for (const [id, label, score, enabled, happened] of [
    [1, "Alpha one", 10, true, "2026-01-01"],
    [2, "Alpha two", 10, false, "2026-02-01"],
    [3, null, 20, true, "2026-03-01"],
  ] as const) {
    await insertRow("events", [
      { column: "id", value: value("integer", id) },
      { column: "label", value: label === null ? value("null") : value("text", label) },
      { column: "score", value: value("real", score) },
      { column: "enabled", value: value("boolean", enabled) },
      { column: "happened", value: value("date", happened) },
    ]);
  }
  expect(
    (
      await readPage(
        "events",
        [],
        [{ column: "label", operator: "contains", value: value("text", "two") }],
      )
    ).total,
  ).toBe(1);
  expect(
    (
      await readPage(
        "events",
        [],
        [{ column: "score", operator: "gte", value: value("integer", 20) }],
      )
    ).total,
  ).toBe(1);
  expect(
    (await readPage("events", [], [{ column: "label", operator: "is_null", value: null }])).total,
  ).toBe(1);
  expect(
    (
      await readPage(
        "events",
        [],
        [{ column: "enabled", operator: "eq", value: value("boolean", false) }],
      )
    ).total,
  ).toBe(1);
  expect(
    (
      await readPage(
        "events",
        [],
        [{ column: "happened", operator: "gt", value: value("date", "2026-01-15") }],
      )
    ).total,
  ).toBe(2);
  const ordered = await readPage("events", [
    { column: "score", descending: false },
    { column: "label", descending: true },
  ]);
  expect(ordered.rows.map((row) => row[0])).toEqual([
    value("integer", 2),
    value("integer", 1),
    value("integer", 3),
  ]);
  const secondPage = await invoke<{ rows: DataValue[][] }>("read_table_page", {
    windowLabel: "main",
    table: "events",
    offset: 1,
    limit: 1,
    sorts: [
      { column: "score", descending: false },
      { column: "label", descending: true },
    ],
    filters: [],
  });
  expect(secondPage.rows[0][0]).toEqual(value("integer", 1));
});
