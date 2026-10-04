import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { insertRow, readPage, refreshDatabase, renderNewDocument, value } from "./helpers";

const LONG = { timeout: 20_000 };

type Column = {
  name: string;
  declaredType: string;
  nullable?: boolean;
  primaryKeyPosition?: number;
};
async function createTableWithKeys(
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

it("generates selectors and related lists over a multi-column foreign key", async () => {
  const user = await renderNewDocument();
  await createTableWithKeys("thresholds", [
    { name: "product_id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "location_id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 2 },
    { name: "label", declaredType: "TEXT" },
  ]);
  await createTableWithKeys(
    "counts",
    [
      { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
      { name: "product_id", declaredType: "INTEGER" },
      { name: "location_id", declaredType: "INTEGER" },
      { name: "counted", declaredType: "INTEGER" },
    ],
    [
      {
        columns: ["product_id", "location_id"],
        targetTable: "thresholds",
        targetColumns: ["product_id", "location_id"],
      },
    ],
  );
  for (const [product, location, label] of [
    [1, 1, "Hammer at depot"],
    [1, 2, "Hammer at store"],
  ] as const)
    await insertRow("thresholds", [
      { column: "product_id", value: value("integer", product) },
      { column: "location_id", value: value("integer", location) },
      { column: "label", value: value("text", label) },
    ]);
  await refreshDatabase();
  await screen.findByRole("button", { name: /^counts\b/ }, LONG);

  await user.click(screen.getByRole("button", { name: "Design" }));
  await user.click(await screen.findByRole("button", { name: "Generate app from tables" }, LONG));
  await screen.findByText("Added 6 forms and pages.", {}, LONG);
  const issues = await invoke<Array<{ severity: string; message: string }>>("validate_design", {
    windowLabel: "main",
  });
  expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);

  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const page = await screen.findByRole("region", { name: "Application page" }, LONG);
  const nav = screen.getByRole("navigation", { name: "Application navigation" });
  await user.click(within(nav).getByRole("button", { name: "Counts" }));
  await user.click(await within(page).findByRole("button", { name: "New counts" }, LONG));
  const form = await screen.findByRole("form", { name: "New Counts" }, LONG);
  const threshold = within(form).getByRole("combobox", { name: "Threshold" });
  await within(threshold).findByRole("option", { name: "Hammer at store" }, LONG);
  await user.selectOptions(threshold, "Hammer at store");
  await user.type(within(form).getByRole("spinbutton", { name: "Counted" }), "4");
  await user.click(within(form).getByRole("button", { name: "Create" }));
  const detail = await screen.findByRole("form", { name: "Counts" }, LONG);
  await waitFor(async () => {
    const counts = await readPage("counts");
    expect(counts.rows.map((row) => row.map((cell) => cell.value))).toEqual([[1, 1, 2, 4]]);
  }, LONG);
  expect(await within(detail).findByDisplayValue("Hammer at store", {}, LONG)).toBeInTheDocument();

  await user.click(within(nav).getByRole("button", { name: "Thresholds" }));
  await user.click((await within(page).findAllByRole("row", { name: "Open 1" }, LONG))[0]);
  const first = await within(page).findByRole("region", { name: "Counts" }, LONG);
  expect(await within(first).findByText("No counts yet.", {}, LONG)).toBeInTheDocument();
  await user.click(within(page).getByRole("button", { name: /^Back to/ }));
  const rows = await within(page).findAllByRole("row", { name: "Open 1" }, LONG);
  await user.click(rows[1]);
  const second = await within(page).findByRole("region", { name: "Counts" }, LONG);
  expect(await within(second).findByRole("cell", { name: "4" }, LONG)).toBeVisible();
});
