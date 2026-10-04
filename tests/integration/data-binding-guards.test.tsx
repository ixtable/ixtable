import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { createTable, renderNewDocument, value } from "./helpers";
import { dialogMock } from "./setup";

type User = Awaited<ReturnType<typeof renderNewDocument>>;
type Config = Record<string, unknown> & {
  savedQueries: unknown[];
  dashboards: unknown[];
  design: { forms: Array<Record<string, unknown>> } & Record<string, unknown>;
};

const LONG = { timeout: 20_000 };
const id = () => crypto.randomUUID();
const at = (column: number, row: number, columnSpan = 6) => ({
  column,
  row,
  columnSpan,
  rowSpan: 2,
});
const field = (label: string, column: string, kind = "text") => ({
  id: id(),
  kind,
  label,
  binding: { column },
  placement: { column: 1, row: label === "Part name" ? 1 : 2, columnSpan: 6, rowSpan: 1 },
});
const insertOp = (n: number) => ({
  op: "insert",
  table: "parts",
  values: [
    { column: "id", value: value("integer", n) },
    { column: "name", value: value("text", `Part ${String(n).padStart(2, "0")}`) },
    { column: "bin", value: value("text", n <= 40 ? "A" : "B") },
    { column: "qty", value: value("integer", 1) },
  ],
});

async function seedParts() {
  await createTable("parts", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT" },
    { name: "bin", declaredType: "TEXT" },
    { name: "qty", declaredType: "INTEGER" },
  ]);
  const ops = Array.from({ length: 60 }, (_, i) => insertOp(i + 1));
  await invoke("execute_write_batch", { windowLabel: "main", ops });
}

async function define(user: User, add: (config: Config) => void) {
  const config = await invoke<Config>("read_document_config", { windowLabel: "main" });
  add(config);
  await invoke("update_document_config", { windowLabel: "main", config });
  const archive = join(process.env.IXTABLE_STATE_DIR ?? "", `guards-${id()}.ixt`);
  dialogMock.save.mockResolvedValueOnce(archive);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, LONG);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  dialogMock.open.mockResolvedValueOnce(archive);
  await user.click(await screen.findByRole("button", { name: /Open document/i }, LONG));
  await screen.findByText("Saved archive", {}, LONG);
}

const binQuery = (queryId: string) => ({
  id: queryId,
  name: "Parts in bin",
  sql: "SELECT id, name FROM parts WHERE bin = $bin ORDER BY id",
  parameters: [{ name: "bin", logicalType: "text", required: true }],
});

it("keeps query forms off record ids and restarts paging when filter params change", async () => {
  const user = await renderNewDocument();
  await seedParts();
  const queryId = id();
  const formId = id();
  const home = id();
  const actionId = id();
  await define(user, (config) => {
    config.savedQueries.push(binQuery(queryId));
    config.design.forms.push({
      id: formId,
      name: "Bin parts",
      source: { kind: "query", queryId, params: { bin: "params.bin" } },
      modes: ["list", "detail"],
      listColumns: ["id", "name"],
      pageSize: 25,
      controls: [field("Part name", "name")],
    });
    config.actions = [
      {
        id: actionId,
        name: "Open by id",
        onError: "stop",
        steps: [{ id: id(), kind: "openForm", formId, mode: "detail", recordId: "3" }],
      },
    ];
    config.dashboards.push({
      id: home,
      name: "Home",
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
        { id: id(), kind: "form", title: "List", formId, mode: "list", placement: at(1, 1) },
        {
          id: id(),
          kind: "form",
          title: "First",
          formId,
          mode: "detail",
          recordId: "params.bin",
          placement: at(7, 1),
        },
        { id: id(), kind: "button", label: "Open by id", actionId, placement: at(1, 3) },
      ],
    });
    config.design.navigation = [{ id: id(), label: "Home", kind: "dashboard", targetId: home }];
    config.design.startPage = null;
  });
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const nav = await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
  await user.click(within(nav).getByRole("button", { name: "Home" }));
  const first = await screen.findByRole("form", { name: "Bin parts" }, LONG);
  await waitFor(
    () => expect(within(first).getByRole("textbox", { name: "Part name" })).toHaveValue("Part 01"),
    LONG,
  );
  const list = await screen.findByRole("region", { name: "Bin parts" }, LONG);
  await within(list).findByText("1–25 of 40", {}, LONG);
  await user.click(within(list).getByRole("button", { name: "Next page" }));
  await within(list).findByText("26–40 of 40", {}, LONG);
  await user.selectOptions(screen.getByRole("combobox", { name: "Bin" }), "B");
  await within(list).findByText("1–20 of 20", {}, LONG);
  expect(within(list).getByRole("button", { name: "Previous page" })).toBeDisabled();

  await user.click(screen.getByRole("button", { name: "Open by id" }));
  expect(
    await screen.findByText(
      "This form shows query rows, so it cannot open a record by id.",
      {},
      LONG,
    ),
  ).toBeInTheDocument();
}, 120_000);

it("lists orphaned query parameter bindings with a Remove action", async () => {
  const user = await renderNewDocument();
  await seedParts();
  const queryId = id();
  const formId = id();
  await define(user, (config) => {
    config.savedQueries.push(binQuery(queryId));
    config.design.forms.push({
      id: formId,
      name: "Bin parts",
      source: { kind: "query", queryId, params: { bin: "'A'", old: "1" } },
      modes: ["list"],
      listColumns: ["id", "name"],
      controls: [],
    });
  });
  await user.click(screen.getByRole("button", { name: "Design" }));
  const forms = await screen.findByRole("region", { name: "Forms" }, LONG);
  await user.click(await within(forms).findByRole("button", { name: "Bin parts" }, LONG));
  await screen.findByText("$old is no longer a parameter of this query.", {}, LONG);
  await user.click(screen.getByRole("button", { name: "Remove binding $old" }));
  await waitFor(async () => {
    const config = await invoke<Config>("read_document_config", { windowLabel: "main" });
    const form = config.design.forms.find((f) => f.id === formId);
    expect(form?.source).toEqual({ kind: "query", queryId, params: { bin: "'A'" } });
  }, LONG);
  expect(screen.queryByText("$old is no longer a parameter of this query.")).toBeNull();
}, 120_000);

it("pins a first-row embedded edit form while it has unsaved changes", async () => {
  const user = await renderNewDocument();
  await seedParts();
  const formId = id();
  await define(user, (config) => {
    config.design.forms.push({
      id: formId,
      name: "Part",
      source: { kind: "table", table: "parts" },
      modes: ["detail", "edit"],
      controls: [field("Part name", "name"), field("Quantity", "qty", "number")],
    });
    config.dashboards.push({
      id: id(),
      name: "Stock",
      components: [
        { id: id(), kind: "form", title: "Edit", formId, mode: "edit", placement: at(1, 1) },
      ],
    });
  });
  await user.click(screen.getByRole("button", { name: "Dashboards" }));
  await user.click(await screen.findByRole("tab", { name: "View" }, LONG));
  const form = await screen.findByRole("form", { name: "Edit Part" }, LONG);
  const name = () => within(form).getByRole("textbox", { name: "Part name" });
  await waitFor(() => expect(name()).toHaveValue("Part 01"), LONG);
  const qty = within(form).getByRole("spinbutton", { name: "Quantity" });
  await user.clear(qty);
  await user.type(qty, "11");

  await invoke("execute_write_batch", { windowLabel: "main", ops: [insertOp(0)] });
  fireEvent(window, new Event("ixtable:records-changed"));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(name()).toHaveValue("Part 01");
  expect(within(form).getByRole("spinbutton", { name: "Quantity" })).toHaveValue(11);

  await user.click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(
    () =>
      expect(
        within(screen.getByRole("form", { name: "Edit Part" })).getByRole("textbox", {
          name: "Part name",
        }),
      ).toHaveValue("Part 00"),
    LONG,
  );

  await invoke("delete_row", {
    windowLabel: "main",
    table: "parts",
    identity: [value("integer", 0)],
  });
  fireEvent(window, new Event("ixtable:records-changed"));
  await screen.findByText(/The record shown here was deleted/, {}, LONG);
  await user.click(screen.getByRole("button", { name: "Show first record" }));
  const again = await screen.findByRole("form", { name: "Edit Part" }, LONG);
  await waitFor(
    () => expect(within(again).getByRole("textbox", { name: "Part name" })).toHaveValue("Part 01"),
    LONG,
  );
  const rows = await invoke<{ rows: Array<Array<{ value?: unknown }>> }>("execute_read_query", {
    windowLabel: "main",
    sql: "SELECT qty FROM parts WHERE id = 1",
  });
  expect(rows.rows[0][0].value).toBe(11);
}, 120_000);

it("offers Record id only for table-sourced embedded forms", async () => {
  const user = await renderNewDocument();
  await seedParts();
  const queryId = id();
  await define(user, (config) => {
    config.savedQueries.push(binQuery(queryId));
    config.design.forms.push(
      {
        id: id(),
        name: "Part",
        source: { kind: "table", table: "parts" },
        modes: ["detail"],
        controls: [field("Part name", "name")],
      },
      {
        id: id(),
        name: "Bin parts",
        source: { kind: "query", queryId, params: { bin: "'A'" } },
        modes: ["detail"],
        controls: [field("Part name", "name")],
      },
    );
  });
  await user.click(screen.getByRole("button", { name: "Dashboards" }));
  const create = await screen.findByRole("button", { name: "New dashboard" }, LONG);
  await waitFor(() => expect(create).toBeEnabled(), LONG);
  await user.click(create);
  await user.click(await screen.findByRole("button", { name: "Add form" }, LONG));
  const properties = screen.getByRole("complementary", { name: "Properties" });
  await user.selectOptions(within(properties).getByRole("combobox", { name: "Form" }), "Part");
  await user.type(within(properties).getByRole("textbox", { name: "Record id" }), "params.id");
  await user.selectOptions(within(properties).getByRole("combobox", { name: "Form" }), "Bin parts");
  await waitFor(() =>
    expect(within(properties).queryByRole("textbox", { name: "Record id" })).toBeNull(),
  );
  await waitFor(async () => {
    const config = await invoke<Config>("read_document_config", { windowLabel: "main" });
    const dashboard = config.dashboards[0] as { components: Array<{ recordId?: unknown }> };
    expect(dashboard.components[0].recordId ?? null).toBeNull();
  }, LONG);
}, 120_000);
