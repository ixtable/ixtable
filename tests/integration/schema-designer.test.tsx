import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import {
  createTable,
  insertRow,
  readPage,
  refreshDatabase,
  renderNewDocument,
  value,
} from "./helpers";

const LONG = { timeout: 20_000 };

type Schema = {
  primaryKey: string[];
  columns: Array<{ name: string; logicalType: string; nullable: boolean }>;
  foreignKeys: Array<{
    fromColumns: string[];
    targetTable: string;
    targetColumns: string[];
    onDelete: string;
  }>;
  uniques: Array<{ columns: string[] }>;
  checks: Array<{ expression: string }>;
  indexes: Array<{ name: string; columns: string[]; unique: boolean }>;
};
const inspect = (table: string) => invoke<Schema>("inspect_table", { windowLabel: "main", table });

it("creates a table with a composite key, relationship, unique, check, and index from the designer", async () => {
  const user = await renderNewDocument();
  await createTable("regions", [
    { name: "code", declaredType: "TEXT", nullable: false, primaryKeyPosition: 1 },
    { name: "title", declaredType: "TEXT" },
  ]);
  await insertRow("regions", [{ column: "code", value: value("text", "N") }]);

  await user.click(screen.getByRole("button", { name: "New table" }));
  const form = await screen.findByRole("form", { name: "Create table" }, LONG);
  await user.type(within(form).getByLabelText("Table name"), "sites");
  const name1 = within(form).getByRole("textbox", { name: "Column 1 name" });
  await user.clear(name1);
  await user.type(name1, "region");
  await user.selectOptions(within(form).getByRole("combobox", { name: "Column 1 type" }), "text");
  const name2 = within(form).getByRole("textbox", { name: "Column 2 name" });
  await user.clear(name2);
  await user.type(name2, "num");
  await user.selectOptions(
    within(form).getByRole("combobox", { name: "Column 2 type" }),
    "integer",
  );
  await user.click(within(form).getByRole("checkbox", { name: "Column 2 primary key" }));
  await user.click(within(form).getByRole("button", { name: "Add column" }));
  await user.type(within(form).getByRole("textbox", { name: "Column 3 name" }), "label");
  await user.click(within(form).getByRole("checkbox", { name: "Column 3 unique" }));
  await user.click(within(form).getByRole("button", { name: "Add column" }));
  await user.type(within(form).getByRole("textbox", { name: "Column 4 name" }), "price");
  await user.selectOptions(
    within(form).getByRole("combobox", { name: "Column 4 type" }),
    "decimal",
  );

  await user.click(within(form).getByRole("checkbox", { name: "Relationship columns: region" }));
  await user.selectOptions(within(form).getByRole("combobox", { name: "Target table" }), "regions");
  await user.selectOptions(
    within(form).getByRole("combobox", { name: "Target column for region" }),
    "code",
  );
  await user.selectOptions(within(form).getByRole("combobox", { name: "On delete" }), "CASCADE");
  await user.click(within(form).getByRole("button", { name: "Add relationship" }));
  await user.type(within(form).getByRole("textbox", { name: "Check expression" }), "num > 0");
  await user.click(within(form).getByRole("button", { name: "Add check" }));
  await user.type(within(form).getByRole("textbox", { name: "Index name" }), "sites_by_price");
  await user.click(within(form).getByRole("checkbox", { name: "Index columns: price" }));
  await user.click(within(form).getByRole("checkbox", { name: "Index columns: num" }));
  await user.click(within(form).getByRole("button", { name: "Add index" }));
  await user.click(within(form).getByRole("button", { name: "Create table" }));

  expect(await screen.findByRole("button", { name: /^sites\b/ }, LONG)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const schema = await inspect("sites");
  expect(schema.primaryKey).toEqual(["region", "num"]);
  expect(schema.columns.map((c) => c.logicalType)).toEqual([
    "text",
    "integer",
    "text",
    "decimal(10,2)",
  ]);
  expect(schema.foreignKeys).toMatchObject([
    {
      fromColumns: ["region"],
      targetTable: "regions",
      targetColumns: ["code"],
      onDelete: "CASCADE",
    },
  ]);
  expect(schema.uniques).toMatchObject([{ columns: ["label"] }]);
  expect(schema.checks).toMatchObject([{ expression: "num > 0" }]);
  expect(schema.indexes).toMatchObject([
    { name: "sites_by_price", columns: ["price", "num"], unique: false },
  ]);

  await expect(
    invoke("insert_row", {
      windowLabel: "main",
      table: "sites",
      values: [
        { column: "region", value: value("text", "missing") },
        { column: "num", value: value("integer", 1) },
      ],
    }),
  ).rejects.toThrow(/Foreign key constraint failed/);
  await expect(
    invoke("insert_row", {
      windowLabel: "main",
      table: "sites",
      values: [
        { column: "region", value: value("text", "N") },
        { column: "num", value: value("integer", 0) },
      ],
    }),
  ).rejects.toThrow(/Check constraint failed/);
  await invoke("insert_row", {
    windowLabel: "main",
    table: "sites",
    values: [
      { column: "region", value: value("text", "N") },
      { column: "num", value: value("integer", 1) },
      { column: "price", value: value("text", "12.5") },
    ],
  });
  expect((await readPage("sites")).rows[0][3]).toEqual(value("decimal", "12.50"));
});

it("labels each staged change by store capability and previews rebuilds and drops", async () => {
  const user = await renderNewDocument();
  await createTable("parts", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "label", declaredType: "TEXT" },
  ]);
  await createTable("bins", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
  ]);
  await invoke("apply_table_changes", {
    windowLabel: "main",
    table: "bins",
    operations: [
      {
        operation: "add_column",
        column: { name: "part", logicalType: "integer", nullable: true },
      },
      {
        operation: "add_foreign_key",
        foreignKey: { columns: ["part"], targetTable: "parts", targetColumns: ["id"] },
      },
    ],
  });
  await insertRow("parts", [
    { column: "id", value: value("integer", 1) },
    { column: "label", value: value("text", "bolt") },
  ]);
  await insertRow("bins", [{ column: "part", value: value("integer", 1) }]);
  await refreshDatabase();
  await user.click(await screen.findByRole("button", { name: /^parts\b/ }, LONG));

  await user.click(await screen.findByRole("button", { name: "Design table" }, LONG));
  await screen.findByRole("heading", { name: "Design parts" }, LONG);
  await user.type(screen.getByRole("textbox", { name: "New column name" }), "note");
  await user.click(screen.getByRole("button", { name: "Add column" }));
  await user.click(screen.getByRole("checkbox", { name: "Column label required" }));
  await user.click(screen.getByRole("button", { name: "Stage changes to label" }));
  const pending = screen.getByRole("region", { name: "Pending changes" });
  expect(await within(pending).findByText("Changes in place", {}, LONG)).toBeInTheDocument();
  expect(await within(pending).findByText("Requires table rebuild", {}, LONG)).toBeInTheDocument();

  await user.click(within(pending).getByRole("button", { name: "Apply changes" }));
  const dialog = await screen.findByRole("dialog", {}, LONG);
  expect(within(dialog).getByText("Rows in parts")).toBeInTheDocument();
  expect(within(dialog).getByText(/bins \(part\): 1 row/)).toBeInTheDocument();
  expect(
    (within(dialog).getByRole("textbox", { name: "Generated SQL" }) as HTMLTextAreaElement).value,
  ).toContain('ALTER TABLE "_ixtable_rebuild_parts" RENAME TO "parts"');
  const confirm = within(dialog).getByRole("button", { name: "Apply changes" });
  expect(confirm).toBeDisabled();
  await user.click(within(dialog).getByRole("checkbox"));
  await user.click(confirm);
  await waitFor(async () => {
    const schema = await inspect("parts");
    expect(schema.columns.map((c) => [c.name, c.nullable])).toEqual([
      ["id", false],
      ["label", false],
      ["note", true],
    ]);
  }, LONG);
  expect((await readPage("parts")).rows[0]).toEqual([
    value("integer", 1),
    value("text", "bolt"),
    value("null"),
  ]);
  expect((await inspect("bins")).foreignKeys[0].targetTable).toBe("parts");

  await user.click(await screen.findByRole("button", { name: "Design table" }, LONG));
  await user.click(await screen.findByRole("button", { name: "Drop table" }, LONG));
  const drop = await screen.findByRole("dialog", { name: "Drop table parts?" }, LONG);
  expect(within(drop).getByText("1")).toBeInTheDocument();
  expect(within(drop).getByRole("textbox", { name: "Generated SQL" })).toHaveValue(
    'DROP TABLE "parts";',
  );
  await user.click(within(drop).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect((await readPage("parts")).total).toBe(1);
});

it("keeps designer drafts through a metadata reload and previews renames and index drops", async () => {
  const user = await renderNewDocument();
  await createTable("parts", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "label", declaredType: "TEXT" },
  ]);
  await invoke("create_index", {
    windowLabel: "main",
    spec: { name: "parts_label", table: "parts", columns: ["label"], unique: false },
  });
  await invoke("save_query", {
    windowLabel: "main",
    id: null,
    name: "Labels",
    sql: "SELECT label FROM parts",
    filterState: null,
  });
  await refreshDatabase();
  await user.click(await screen.findByRole("button", { name: /^parts\b/ }, LONG));
  await user.click(await screen.findByRole("button", { name: "Design table" }, LONG));
  await screen.findByRole("heading", { name: "Design parts" }, LONG);
  expect(await screen.findByText(/SQLite record store\./, {}, LONG)).toBeInTheDocument();
  const actions = within(screen.getByRole("region", { name: "Relationships" })).getByRole(
    "combobox",
    { name: "On delete" },
  );
  expect(
    within(actions)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"]);

  const heading = screen.getByRole("heading", { name: "Design parts" });
  await user.type(screen.getByRole("textbox", { name: "Column label default" }), "'none'");
  await refreshDatabase();
  expect(screen.getByRole("heading", { name: "Design parts" })).toBe(heading);
  expect(screen.getByRole("textbox", { name: "Column label default" })).toHaveValue("'none'");

  const tableName = screen.getByRole("textbox", { name: "Table name" });
  await user.clear(tableName);
  await user.type(tableName, "items");
  await user.click(screen.getByRole("button", { name: "Rename table" }));
  const pending = screen.getByRole("region", { name: "Pending changes" });
  await within(pending).findByText("Changes in place", {}, LONG);
  await user.click(within(pending).getByRole("button", { name: "Apply changes" }));
  const rename = await screen.findByRole("dialog", {}, LONG);
  expect(within(rename).getByText("query “Labels”")).toBeInTheDocument();
  expect(within(rename).getByText(/does not update definitions/)).toBeInTheDocument();
  const confirmRename = within(rename).getByRole("button", { name: "Apply changes" });
  expect(confirmRename).toBeDisabled();
  await user.click(within(rename).getByRole("checkbox"));
  expect(confirmRename).toBeEnabled();
  await user.click(within(rename).getByRole("button", { name: "Cancel" }));
  await user.click(within(pending).getByRole("button", { name: "Discard changes" }));

  await user.click(screen.getByRole("button", { name: "Drop index parts_label" }));
  const drop = await screen.findByRole("dialog", { name: "Drop index parts_label?" }, LONG);
  expect(within(drop).getByRole("textbox", { name: "Generated SQL" })).toHaveValue(
    'DROP INDEX "parts_label";',
  );
  const confirmDrop = within(drop).getByRole("button", { name: "Drop index" });
  expect(confirmDrop).toBeDisabled();
  await user.click(within(drop).getByRole("button", { name: "Cancel" }));
  expect((await inspect("parts")).indexes).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Drop index parts_label" }));
  const again = await screen.findByRole("dialog", { name: "Drop index parts_label?" }, LONG);
  await user.click(within(again).getByRole("checkbox"));
  await user.click(within(again).getByRole("button", { name: "Drop index" }));
  await waitFor(async () => expect((await inspect("parts")).indexes).toEqual([]), LONG);
  expect((await inspect("parts")).columns.map((c) => c.name)).toEqual(["id", "label"]);
});

it("creates a relationship from the diagram through the prefilled relationship editor", async () => {
  const user = await renderNewDocument();
  await createTable("parts", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
  ]);
  await createTable("bins", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "part", declaredType: "INTEGER" },
  ]);
  await refreshDatabase();
  await user.click(await screen.findByRole("button", { name: "New relationship" }, LONG));
  const editor = await screen.findByRole("dialog", { name: "New relationship" }, LONG);
  await user.selectOptions(
    within(editor).getByRole("combobox", { name: "Referencing table" }),
    "bins",
  );
  await user.click(within(editor).getByRole("checkbox", { name: "Relationship columns: part" }));
  await user.selectOptions(within(editor).getByRole("combobox", { name: "Target table" }), "parts");
  await user.selectOptions(
    within(editor).getByRole("combobox", { name: "Target column for part" }),
    "id",
  );
  await user.selectOptions(within(editor).getByRole("combobox", { name: "On delete" }), "CASCADE");
  await user.click(within(editor).getByRole("button", { name: "Preview relationship" }));
  const preview = await screen.findByRole("dialog", { name: "Relate bins (part) to parts?" }, LONG);
  await user.click(within(preview).getByRole("checkbox"));
  await user.click(within(preview).getByRole("button", { name: "Create relationship" }));
  await waitFor(async () => {
    expect((await inspect("bins")).foreignKeys).toMatchObject([
      { fromColumns: ["part"], targetTable: "parts", targetColumns: ["id"], onDelete: "CASCADE" },
    ]);
  }, LONG);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), LONG);
});

it("returns to the relationship editor with its choices when the preview is cancelled", async () => {
  const user = await renderNewDocument();
  await createTable("parts", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
  ]);
  await createTable("bins", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "part", declaredType: "INTEGER" },
  ]);
  await refreshDatabase();
  await user.click(await screen.findByRole("button", { name: "New relationship" }, LONG));
  let editor = await screen.findByRole("dialog", { name: "New relationship" }, LONG);
  await user.selectOptions(
    within(editor).getByRole("combobox", { name: "Referencing table" }),
    "bins",
  );
  await user.click(within(editor).getByRole("checkbox", { name: "Relationship columns: part" }));
  await user.selectOptions(within(editor).getByRole("combobox", { name: "Target table" }), "parts");
  await user.selectOptions(
    within(editor).getByRole("combobox", { name: "Target column for part" }),
    "id",
  );
  await user.selectOptions(within(editor).getByRole("combobox", { name: "On delete" }), "CASCADE");
  await user.click(within(editor).getByRole("button", { name: "Preview relationship" }));
  const preview = await screen.findByRole("dialog", { name: "Relate bins (part) to parts?" }, LONG);
  await user.click(within(preview).getByRole("button", { name: "Cancel" }));
  editor = await screen.findByRole("dialog", { name: "New relationship" }, LONG);
  expect(
    within(editor).getByRole("checkbox", { name: "Relationship columns: part" }),
  ).toBeChecked();
  expect(within(editor).getByRole("combobox", { name: "Target table" })).toHaveValue("parts");
  expect(within(editor).getByRole("combobox", { name: "On delete" })).toHaveValue("CASCADE");
  await user.click(within(editor).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), LONG);
});
