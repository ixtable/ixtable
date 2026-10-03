import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { createTable, insertRow, renderNewDocument, value } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };

type Placement = { column: number; row: number; columnSpan: number; rowSpan: number };
type Config = {
  savedQueries: Array<{ id: string; name: string; parameters: unknown[] }>;
  dashboards: Array<{
    name: string;
    filters: Array<{ param: string; control: string; options?: string[] }>;
    components: Array<{ kind: string; title: string; placement: Placement; queryId?: string }>;
  }>;
};
const readConfig = () => invoke<Config>("read_document_config", { windowLabel: "main" });

async function seedSales() {
  await createTable("sales", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "region", declaredType: "TEXT" },
    { name: "amount", declaredType: "REAL" },
  ]);
  const rows: Array<[string, number]> = [
    ["East", 100],
    ["East", 250],
    ["West", 400],
    ["North", 50],
  ];
  for (const [i, [region, amount]] of rows.entries())
    await insertRow("sales", [
      { column: "id", value: value("integer", i + 1) },
      { column: "region", value: value("text", region) },
      { column: "amount", value: value("real", amount) },
    ]);
  const config = await invoke<Config & Record<string, unknown>>("read_document_config", {
    windowLabel: "main",
  });
  config.savedQueries = [
    {
      id: "6d1f8e2a-0c39-4c55-9a4c-2b8f9f6f7a01",
      name: "Sales by region",
      sql: "SELECT region, SUM(amount) AS total FROM sales WHERE ($region IS NULL OR region = $region) GROUP BY region ORDER BY region",
      parameters: [{ name: "region", logicalType: "text", required: false }],
    },
  ];
  await invoke("update_document_config", { windowLabel: "main", config });
}

it("builds a KPI, bar chart and filter on the shared grid, views live data, and persists a keyboard resize", async () => {
  const user = await renderNewDocument();
  await seedSales();
  const archive = join(process.env.IXTABLE_STATE_DIR ?? "", "dashboard.ixt");
  dialogMock.save.mockResolvedValueOnce(archive);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, LONG);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  dialogMock.open.mockResolvedValueOnce(archive);
  await user.click(await screen.findByRole("button", { name: /Open document/i }, LONG));
  await screen.findByText("Saved archive", {}, LONG);

  await user.click(screen.getByRole("button", { name: "Dashboards" }));
  const create = await screen.findByRole("button", { name: "New dashboard" }, LONG);
  await waitFor(() => expect(create).toBeEnabled(), LONG);
  await user.click(create);
  await user.click(await screen.findByRole("button", { name: "Add KPI" }, LONG));
  const properties = screen.getByRole("complementary", { name: "Properties" });
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Query" }),
    "Sales by region",
  );
  await user.type(
    within(properties).getByRole("textbox", { name: "Value expression" }),
    "sum(rows.total)",
  );
  await user.type(within(properties).getByRole("textbox", { name: "Format" }), "#,##0");
  await user.click(screen.getByRole("button", { name: "Add chart" }));
  await user.selectOptions(
    within(properties).getByRole("combobox", { name: "Query" }),
    "Sales by region",
  );
  const xField = within(properties).getByRole("combobox", { name: "X field" });
  await within(xField).findByRole("option", { name: "region" }, LONG);
  await user.selectOptions(xField, "region");
  await user.click(within(properties).getByRole("checkbox", { name: "total" }));
  await user.click(within(properties).getByRole("button", { name: "Dashboard settings" }));
  await user.click(within(properties).getByRole("button", { name: "Add filter" }));
  const filter = within(properties).getByRole("group", { name: "Filter Region" });
  expect(within(filter).getByRole("combobox", { name: "Parameter" })).toHaveValue("region");
  await user.type(within(filter).getByRole("textbox", { name: "Choices" }), "East, North, West");

  await waitFor(async () => {
    const [dashboard] = (await readConfig()).dashboards;
    expect(dashboard.filters).toEqual([
      expect.objectContaining({
        param: "region",
        control: "select",
        options: ["East", "North", "West"],
      }),
    ]);
    expect(dashboard.components.map((c) => [c.kind, c.title])).toEqual([
      ["kpi", "KPI 1"],
      ["chart", "Chart 1"],
    ]);
  }, LONG);
  await user.click(screen.getByRole("tab", { name: "View" }));
  const kpi = await screen.findByRole("region", { name: "KPI 1" }, LONG);
  expect(await within(kpi).findByText("800", {}, LONG)).toBeInTheDocument();
  const data = await screen.findByRole("table", { name: "Chart 1 data" }, LONG);
  expect(
    within(data)
      .getAllByRole("row")
      .map((r) => r.textContent),
  ).toEqual(["regiontotal", "East350", "North50", "West400"]);
  expect(
    screen.getByRole("img", {
      name: /^Chart 1\. Bar chart: 1 series over 3 region\. Values from 50 to 400\./,
    }),
  ).toBeInTheDocument();
  await user.selectOptions(screen.getByRole("combobox", { name: "Region" }), "East");
  expect(await within(kpi).findByText("350", {}, LONG)).toBeInTheDocument();
  await waitFor(() =>
    expect(
      within(screen.getByRole("table", { name: "Chart 1 data" }))
        .getAllByRole("row")
        .map((r) => r.textContent),
    ).toEqual(["regiontotal", "East350"]),
  );
  await user.click(screen.getByRole("tab", { name: "Design" }));
  const item = await screen.findByRole("group", { name: "KPI 1" }, LONG);
  item.focus();
  await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
  await waitFor(async () => {
    const [dashboard] = (await readConfig()).dashboards;
    expect(dashboard.components[0].placement).toMatchObject({
      column: 1,
      row: 1,
      columnSpan: 4,
      rowSpan: 1,
    });
  }, LONG);
});
