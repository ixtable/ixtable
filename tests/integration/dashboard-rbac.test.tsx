import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { asTauriError } from "../../src/lib/api";
import { createTable, insertRow, renderNewDocument, value } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };
const id = () => crypto.randomUUID();
const at = (column: number) => ({ column, row: 1, columnSpan: 6, rowSpan: 2 });

it("lets a role granted only a dashboard read the dashboard's queries", async () => {
  const user = await renderNewDocument();
  await createTable("sales", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "region", declaredType: "TEXT" },
    { name: "amount", declaredType: "REAL" },
  ]);
  for (const [i, [region, amount]] of (
    [
      ["East", 100],
      ["West", 400],
    ] as const
  ).entries())
    await insertRow("sales", [
      { column: "id", value: value("integer", i + 1) },
      { column: "region", value: value("text", region) },
      { column: "amount", value: value("real", amount) },
    ]);
  const [total, regions, secret, home, nav] = [id(), id(), id(), id(), id()];
  const config = await invoke<Record<string, unknown> & { design: Record<string, unknown> }>(
    "read_document_config",
    { windowLabel: "main" },
  );
  const region = [{ name: "region", logicalType: "text", required: false }];
  config.savedQueries = [
    {
      id: total,
      name: "Total",
      sql: "SELECT SUM(amount) AS total FROM sales WHERE ($region IS NULL OR region = $region)",
      parameters: region,
    },
    { id: regions, name: "Regions", sql: "SELECT DISTINCT region FROM sales ORDER BY region" },
    { id: secret, name: "Secret", sql: "SELECT * FROM sales" },
  ];
  config.dashboards = [
    {
      id: home,
      name: "Home",
      filters: [
        { id: id(), name: "Region", param: "region", control: "select", optionsQueryId: regions },
      ],
      components: [
        { id: id(), kind: "kpi", title: "Revenue", queryId: total, valueField: "total", placement: at(1) },
        { id: id(), kind: "table", title: "Totals", queryId: total, placement: at(7) },
      ],
    },
  ];
  config.design.navigation = [{ id: nav, label: "Home", kind: "dashboard", targetId: home }];
  config.design.startPage = null;
  const grant = { kind: "dashboard", id: home, read: true };
  config.roles = [
    { id: "viewer", name: "Viewer", permissions: { navigation: [nav], objects: [grant] } },
  ];
  await invoke("update_document_config", { windowLabel: "main", config });
  const archive = join(process.env.IXTABLE_STATE_DIR ?? "", `dashboard-rbac-${id()}.ixt`);
  dialogMock.save.mockResolvedValueOnce(archive);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, LONG);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  dialogMock.open.mockResolvedValueOnce(archive);
  await user.click(await screen.findByRole("button", { name: /Open document/i }, LONG));
  await screen.findByText("Saved archive", {}, LONG);

  await user.click(screen.getByRole("button", { name: "Runtime" }));
  await user.selectOptions(
    await screen.findByRole("combobox", { name: "Preview as role" }, LONG),
    "Viewer",
  );
  const menu = await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
  await user.click(await within(menu).findByRole("button", { name: "Home" }, LONG));
  const kpi = await screen.findByRole("region", { name: "Revenue" }, LONG);
  expect(await within(kpi).findByText("500", {}, LONG)).toBeInTheDocument();
  const table = await screen.findByRole("region", { name: "Totals" }, LONG);
  expect(await within(table).findByText("500", {}, LONG)).toBeInTheDocument();
  expect(screen.queryByText("You do not have access to this data.")).toBeNull();
  const filter = screen.getByRole("combobox", { name: "Region" });
  await within(filter).findByRole("option", { name: "West" }, LONG);
  await user.selectOptions(filter, "East");
  expect(await within(kpi).findByText("100", {}, LONG)).toBeInTheDocument();

  const code = (command: string, args: Record<string, unknown>) =>
    invoke(command, { windowLabel: "main", runId: null, params: [], ...args }).then(
      () => "OK",
      (error: unknown) => asTauriError(error).code,
    );
  await waitFor(
    async () => expect(await code("run_saved_query", { id: secret, limit: null })).toBe("FORBIDDEN"),
    LONG,
  );
  expect(await code("run_saved_query", { id: total, limit: null })).toBe("OK");
  expect(await code("run_saved_query", { id: regions, limit: null })).toBe("OK");
  const page = { table: "sales", offset: 0, limit: 10, sorts: [], filters: [] };
  expect(await code("read_table_page", page)).toBe("FORBIDDEN");
  const row = [{ column: "id", value: value("integer", 9) }];
  expect(await code("insert_row", { table: "sales", values: row })).toBe("FORBIDDEN");
}, 120_000);
