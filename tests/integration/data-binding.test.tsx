import { screen, waitFor, within } from "@testing-library/react";
import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { createTable, renderNewDocument, value } from "./helpers";
import { dialogMock } from "./setup";

type User = Awaited<ReturnType<typeof renderNewDocument>>;

const LONG = { timeout: 20_000 };
const id = () => crypto.randomUUID();
const at = (column: number, row: number, columnSpan = 6) => ({
  column,
  row,
  columnSpan,
  rowSpan: 2,
});

async function seedParts() {
  await createTable("parts", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT" },
    { name: "bin", declaredType: "TEXT" },
    { name: "qty", declaredType: "INTEGER" },
  ]);
  const ops = Array.from({ length: 60 }, (_, i) => ({
    op: "insert",
    table: "parts",
    values: [
      { column: "id", value: value("integer", i + 1) },
      { column: "name", value: value("text", `Part ${String(i + 1).padStart(2, "0")}`) },
      { column: "bin", value: value("text", i < 40 ? "A" : "B") },
      { column: "qty", value: value("integer", 1) },
    ],
  }));
  await invoke("execute_write_batch", { windowLabel: "main", ops });
}

type Config = Record<string, unknown> & {
  savedQueries: unknown[];
  dashboards: unknown[];
  design: { forms: unknown[] } & Record<string, unknown>;
};

async function define(user: User, add: (config: Config) => void) {
  const config = await invoke<Config>("read_document_config", { windowLabel: "main" });
  add(config);
  await invoke("update_document_config", { windowLabel: "main", config });
  const archive = join(process.env.IXTABLE_STATE_DIR ?? "", `binding-${id()}.ixt`);
  dialogMock.save.mockResolvedValueOnce(archive);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, LONG);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  dialogMock.open.mockResolvedValueOnce(archive);
  await user.click(await screen.findByRole("button", { name: /Open document/i }, LONG));
  await screen.findByText("Saved archive", {}, LONG);
}

async function openDashboardView(user: User) {
  await user.click(screen.getByRole("button", { name: "Dashboards" }));
  await user.click(await screen.findByRole("tab", { name: "View" }, LONG));
}

it("pages a parameterized query-sourced form in DuckDB with dashboard filter values as params", async () => {
  const user = await renderNewDocument();
  await seedParts();
  const queryId = id();
  await define(user, (config) => {
    config.savedQueries.push({
      id: queryId,
      name: "Parts in bin",
      sql: "SELECT id, name FROM parts WHERE bin = $bin ORDER BY id",
      parameters: [{ name: "bin", logicalType: "text", required: true }],
    });
    const formId = id();
    config.design.forms.push({
      id: formId,
      name: "Bin parts",
      source: { kind: "query", queryId, params: { bin: "params.bin" } },
      modes: ["list", "detail"],
      listColumns: ["id", "name"],
      pageSize: 25,
    });
    config.dashboards.push({
      id: id(),
      name: "Stock",
      filters: [
        {
          id: id(),
          name: "Bin",
          param: "bin",
          control: "select",
          options: ["A", "B"],
          default: "A",
        },
      ],
      components: [
        { id: id(), kind: "form", title: "Parts", formId, mode: "list", placement: at(1, 1, 12) },
      ],
    });
  });
  await openDashboardView(user);
  const list = await screen.findByRole("region", { name: "Bin parts" }, LONG);
  await within(list).findByText("1–25 of 40", {}, LONG);
  await user.click(within(list).getByRole("button", { name: "Next page" }));
  await within(list).findByText("26–40 of 40", {}, LONG);
  await within(list).findByRole("row", { name: "Open 40" }, LONG);
  const firstRow = () => within(list).getAllByRole("row")[1];
  await user.click(within(list).getByRole("button", { name: "Id" }));
  await user.click(within(list).getByRole("button", { name: "Id" }));
  await waitFor(() => expect(firstRow()).toHaveAccessibleName("Open 40"), LONG);
  expect(within(list).getByText("1–25 of 40")).toBeInTheDocument();
  await user.selectOptions(within(list).getByRole("combobox", { name: "Search column" }), "name");
  await user.type(within(list).getByRole("searchbox", { name: "Search Bin parts" }), "part 3");
  await within(list).findByText("1–10 of 10", {}, LONG);

  await user.selectOptions(screen.getByRole("combobox", { name: "Bin" }), "B");
  await within(list).findByText("0 records", {}, LONG);
  await user.clear(within(list).getByRole("searchbox", { name: "Search Bin parts" }));
  await within(list).findByText("1–20 of 20", {}, LONG);
  await waitFor(() => expect(firstRow()).toHaveAccessibleName("Open 60"), LONG);
}, 120_000);

it("edits a record through a dashboard-embedded form and refreshes the KPI", async () => {
  const user = await renderNewDocument();
  await seedParts();
  const queryId = id();
  await define(user, (config) => {
    config.savedQueries.push({
      id: queryId,
      name: "Total quantity",
      sql: "SELECT sum(qty) AS total FROM parts WHERE ($bin IS NULL OR bin = $bin)",
      parameters: [{ name: "bin", logicalType: "text", required: false }],
    });
    const formId = id();
    config.design.forms.push({
      id: formId,
      name: "Part",
      source: { kind: "table", table: "parts" },
      modes: ["detail", "edit"],
      controls: [
        {
          id: id(),
          kind: "number",
          label: "Quantity",
          binding: { column: "qty" },
          placement: { column: 1, row: 1, columnSpan: 6, rowSpan: 1 },
        },
      ],
    });
    config.dashboards.push({
      id: id(),
      name: "Stock",
      filters: [
        { id: id(), name: "Bin", param: "bin", control: "select", options: ["A", "B"] },
        { id: id(), name: "Part id", param: "part", control: "number", default: 3 },
      ],
      components: [
        {
          id: id(),
          kind: "kpi",
          title: "Units",
          queryId,
          valueField: "total",
          placement: at(1, 1),
        },
        {
          id: id(),
          kind: "form",
          title: "Edit part",
          formId,
          mode: "edit",
          recordId: "params.part",
          placement: at(7, 1),
        },
      ],
    });
  });
  await openDashboardView(user);
  const kpi = await screen.findByRole("region", { name: "Units" }, LONG);
  await within(kpi).findByText("60", {}, LONG);
  const form = await screen.findByRole("form", { name: "Edit Part" }, LONG);
  const qty = await within(form).findByRole("spinbutton", { name: "Quantity" }, LONG);
  await waitFor(() => expect(qty).toHaveValue(1), LONG);
  await user.clear(qty);
  await user.type(qty, "11");
  await user.click(within(form).getByRole("button", { name: "Save" }));
  await within(kpi).findByText("70", {}, LONG);
  const rows = await invoke<{ rows: Array<Array<{ value?: unknown }>> }>("execute_read_query", {
    windowLabel: "main",
    sql: "SELECT qty FROM parts WHERE id = 3",
  });
  expect(rows.rows[0][0].value).toBe(11);
}, 120_000);

it("opens a dashboard from an action with params that reach filters, query forms and first-row binding", async () => {
  const user = await renderNewDocument();
  await seedParts();
  const queryId = id();
  const formId = id();
  const home = id();
  const binView = id();
  const actionId = id();
  await define(user, (config) => {
    config.savedQueries.push({
      id: queryId,
      name: "Parts in bin",
      sql: "SELECT id, name FROM parts WHERE bin = $bin ORDER BY id",
      parameters: [{ name: "bin", logicalType: "text", required: true }],
    });
    config.design.forms.push({
      id: formId,
      name: "Bin parts",
      source: { kind: "query", queryId, params: { bin: "params.bin" } },
      modes: ["list", "detail"],
      listColumns: ["id", "name"],
      controls: [
        {
          id: id(),
          kind: "text",
          label: "Part name",
          binding: { column: "name" },
          placement: { column: 1, row: 1, columnSpan: 6, rowSpan: 1 },
        },
      ],
    });
    config.actions = [
      {
        id: actionId,
        name: "Show bin B",
        onError: "stop",
        steps: [{ id: id(), kind: "openDashboard", dashboardId: binView, params: { bin: "'B'" } }],
      },
    ];
    config.dashboards.push(
      {
        id: home,
        name: "Home",
        components: [
          { id: id(), kind: "button", label: "Show bin B", actionId, placement: at(1, 1) },
        ],
      },
      {
        id: binView,
        name: "Bin view",
        filters: [{ id: id(), name: "Bin", param: "bin", control: "select", options: ["A", "B"] }],
        components: [
          { id: id(), kind: "form", title: "List", formId, mode: "list", placement: at(1, 1) },
          { id: id(), kind: "form", title: "First", formId, mode: "detail", placement: at(7, 1) },
        ],
      },
    );
    config.design.navigation = [{ id: id(), label: "Home", kind: "dashboard", targetId: home }];
    config.design.startPage = null;
  });
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const nav = await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
  await user.click(within(nav).getByRole("button", { name: "Home" }));
  await user.click(await screen.findByRole("button", { name: "Show bin B" }, LONG));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Bin" })).toHaveValue("B"), LONG);
  const list = await screen.findByRole("region", { name: "Bin parts" }, LONG);
  await within(list).findByText("1–20 of 20", {}, LONG);
  const first = await screen.findByRole("form", { name: "Bin parts" }, LONG);
  await waitFor(
    () => expect(within(first).getByRole("textbox", { name: "Part name" })).toHaveValue("Part 41"),
    LONG,
  );
}, 120_000);

it("pages related records like list forms", async () => {
  const user = await renderNewDocument();
  await seedParts();
  await createTable("bins", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "code", declaredType: "TEXT" },
  ]);
  await invoke("execute_write_batch", {
    windowLabel: "main",
    ops: ["A", "B"].map((code, i) => ({
      op: "insert",
      table: "bins",
      values: [
        { column: "id", value: value("integer", i + 1) },
        { column: "code", value: value("text", code) },
      ],
    })),
  });
  const formId = id();
  await define(user, (config) => {
    config.design.forms.push({
      id: formId,
      name: "Bins",
      source: { kind: "table", table: "bins" },
      modes: ["list", "detail"],
      listColumns: ["code"],
      controls: [
        {
          id: id(),
          kind: "text",
          label: "Code",
          binding: { column: "code" },
          placement: { column: 1, row: 1, columnSpan: 6, rowSpan: 1 },
        },
        {
          id: id(),
          kind: "relatedList",
          label: "Parts",
          related: { table: "parts", foreignKey: "bin", parentColumn: "code", columns: ["name"] },
          placement: { column: 1, row: 2, columnSpan: 12, rowSpan: 3 },
        },
      ],
    });
    config.design.navigation = [{ id: id(), label: "Bins", kind: "form", targetId: formId }];
    config.design.startPage = null;
  });
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const nav = await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
  await user.click(within(nav).getByRole("button", { name: "Bins" }));
  await user.click(await screen.findByRole("row", { name: "Open A" }, LONG));
  const parts = await screen.findByRole("region", { name: "Parts" }, LONG);
  await within(parts).findByText("1–25 of 40", {}, LONG);
  await within(parts).findByRole("cell", { name: "Part 25" }, LONG);
  await user.click(within(parts).getByRole("button", { name: "Next page of parts" }));
  await within(parts).findByText("26–40 of 40", {}, LONG);
  await within(parts).findByRole("cell", { name: "Part 40" }, LONG);
  expect(within(parts).queryByRole("cell", { name: "Part 25" })).toBeNull();
  expect(within(parts).getByRole("button", { name: "Next page of parts" })).toBeDisabled();
}, 120_000);
