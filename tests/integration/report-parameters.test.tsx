import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { newReport } from "../../src/reports/model";
import { createTable, insertRow, renderNewDocument, value } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };
const QUERY = "7a1f8e2a-0c39-4c55-9a4c-2b8f9f6f7a02";

async function seed(user: Awaited<ReturnType<typeof renderNewDocument>>) {
  await createTable("sales", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "region", declaredType: "TEXT" },
    { name: "amount", declaredType: "REAL" },
  ]);
  const rows: [string, number][] = [
    ["West", 120],
    ["East", 80],
    ["West", 40],
    ["West", 300],
  ];
  for (const [i, [region, amount]] of rows.entries())
    await insertRow("sales", [
      { column: "id", value: value("integer", i + 1) },
      { column: "region", value: value("text", region) },
      { column: "amount", value: value("real", amount) },
    ]);
  const config = await invoke<Record<string, unknown> & { design: Record<string, unknown> }>(
    "read_document_config",
    { windowLabel: "main" },
  );
  const report = newReport("Regional sales");
  report.datasetQueryId = QUERY;
  report.params = { region: "West" };
  report.bands.detail.components = [
    {
      id: "f1",
      kind: "field",
      expression: "record.region & ' ' & record.amount",
      x: 0,
      y: 0,
      w: 200,
      h: 16,
    },
  ];
  await invoke("update_document_config", {
    windowLabel: "main",
    config: {
      ...config,
      savedQueries: [
        {
          id: QUERY,
          name: "Sales by region",
          sql: "SELECT region, amount FROM sales WHERE region = $region AND amount >= $minimum ORDER BY id",
          parameters: [
            { name: "region", logicalType: "text", required: true },
            { name: "minimum", logicalType: "number", required: true, defaultValue: 0 },
          ],
        },
      ],
      reports: [report],
      design: {
        ...config.design,
        navigation: [
          { id: "nav-report", label: "Sales report", kind: "report", targetId: report.id },
        ],
      },
    },
  });
  const archive = join(process.env.IXTABLE_STATE_DIR ?? "", "report-parameters.ixt");
  dialogMock.save.mockResolvedValueOnce(archive);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, LONG);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  dialogMock.open.mockResolvedValueOnce(archive);
  await user.click(await screen.findByRole("button", { name: /Open document/i }, LONG));
  await screen.findByText("Saved archive", {}, LONG);
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  await screen.findByRole("region", { name: "Application page" }, LONG);
}

const pageText = async () =>
  (await screen.findByRole("img", { name: "Page 1 of 1" }, LONG)).textContent ?? "";

it("prompts for report parameters when Runtime navigation opens a parameterised report", async () => {
  const user = await renderNewDocument();
  await seed(user);
  const nav = screen.getByRole("navigation", { name: "Application navigation" });
  await user.click(await within(nav).findByRole("button", { name: "Sales report" }, LONG));

  const dialog = await screen.findByRole("dialog", { name: "Regional sales parameters" }, LONG);
  const region = within(dialog).getByRole("textbox", { name: /region/ });
  const minimum = within(dialog).getByRole("spinbutton", { name: /minimum/ });
  expect(region).toHaveValue("West");
  expect(minimum).toHaveValue(0);
  expect(region).toHaveFocus();
  expect(screen.queryByRole("img", { name: /^Page / })).toBeNull();

  await user.clear(minimum);
  await user.click(within(dialog).getByRole("button", { name: "Run report" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter a value for minimum.");
  await user.type(minimum, "100");
  await user.click(within(dialog).getByRole("button", { name: "Run report" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(async () => expect(await pageText()).toContain("West 120"), LONG);
  const text = await pageText();
  expect(text).toContain("West 300");
  expect(text).not.toContain("West 40");
  expect(text).not.toContain("East");

  await user.click(screen.getByRole("button", { name: "Change parameters…" }));
  const again = await screen.findByRole("dialog", { name: "Regional sales parameters" });
  expect(within(again).getByRole("spinbutton", { name: /minimum/ })).toHaveValue(100);
  await user.click(within(again).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await pageText()).toContain("West 300");

  await user.click(within(nav).getByRole("button", { name: "Sales report" }));
  const third = await screen.findByRole("dialog", { name: "Regional sales parameters" }, LONG);
  await user.keyboard("{Escape}");
  expect(third).not.toBeInTheDocument();
  await screen.findByText("The report was not run.");
  await user.click(screen.getByRole("button", { name: "Enter parameters…" }));
  await screen.findByRole("dialog", { name: "Regional sales parameters" });
}, 120_000);
