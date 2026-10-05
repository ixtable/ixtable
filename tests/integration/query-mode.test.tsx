import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { insertRow, refreshDatabase, renderNewDocument, value } from "./helpers";

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MiniMap: () => null,
  Position: { Left: "left", Right: "right" },
  ReactFlow: ({ children }: { children: ReactNode }) => children,
}));

const LONG = { timeout: 20_000 };

type Config = {
  savedQueries: Array<{
    id: string;
    name: string;
    sql: string;
    parameters: Array<{
      name: string;
      logicalType: string;
      required: boolean;
      defaultValue: unknown;
    }>;
    builder: { sources: Array<{ table: string; alias: string }>; joins: unknown[] } | null;
  }>;
};
const readConfig = () => invoke<Config>("read_document_config", { windowLabel: "main" });

const column = (name: string, declaredType: string, primaryKeyPosition = 0) => ({
  name,
  declaredType,
  nullable: primaryKeyPosition === 0,
  primaryKeyPosition,
  unique: false,
  defaultExpression: null,
  generatedExpression: null,
});

async function seedSales() {
  await invoke("create_database_table", {
    windowLabel: "main",
    spec: {
      name: "customers",
      columns: [column("id", "INTEGER", 1), column("name", "TEXT")],
      foreignKeys: [],
      checks: [],
      withoutRowid: false,
    },
  });
  await invoke("create_database_table", {
    windowLabel: "main",
    spec: {
      name: "orders",
      columns: [
        column("id", "INTEGER", 1),
        column("customer_id", "INTEGER"),
        column("amount", "REAL"),
      ],
      foreignKeys: [
        {
          columns: ["customer_id"],
          targetTable: "customers",
          targetColumns: ["id"],
          onUpdate: null,
          onDelete: null,
        },
      ],
      checks: [],
      withoutRowid: false,
    },
  });
  for (const [id, name] of [
    [1, "ACME"],
    [2, "Bolt"],
    [3, "Core"],
  ] as const)
    await insertRow("customers", [
      { column: "id", value: value("integer", id) },
      { column: "name", value: value("text", name) },
    ]);
  for (const [id, customer, amount] of [
    [1, 1, 10],
    [2, 1, 30],
    [3, 2, 5],
    [4, 2, 50],
    [5, 3, 1],
  ] as const)
    await insertRow("orders", [
      { column: "id", value: value("integer", id) },
      { column: "customer_id", value: value("integer", customer) },
      { column: "amount", value: value("real", amount) },
    ]);
  await refreshDatabase();
  await screen.findByRole("button", { name: "orders" }, LONG);
}

async function gridRows(regionName: string, expected: string[][]) {
  const region = await screen.findByRole("region", { name: regionName }, LONG);
  await waitFor(() => {
    const rows = within(region)
      .getAllByRole("row")
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual(expected);
  }, LONG);
}

async function openQueryMode() {
  const user = await renderNewDocument();
  await seedSales();
  await user.click(screen.getByRole("button", { name: "Query" }));
  await screen.findByRole("heading", { name: "Query" }, LONG);
  return user;
}

it("builds a joined, grouped query with a filter parameter, previews, saves, reopens, and runs it", async () => {
  const user = await openQueryMode();
  await user.click(screen.getByRole("button", { name: "New query" }));
  expect(screen.getByRole("tab", { name: "Builder" })).toHaveAttribute("aria-selected", "true");

  await user.selectOptions(await screen.findByRole("combobox", { name: "Source table" }), "orders");
  await user.click(
    await screen.findByRole(
      "button",
      { name: "Join customers on o.customer_id = customers.id" },
      LONG,
    ),
  );
  expect(screen.getByRole("combobox", { name: "Join type for c" })).toHaveValue("inner");
  await user.click(await screen.findByRole("checkbox", { name: "c.name" }, LONG));
  await user.click(screen.getByRole("checkbox", { name: "o.amount" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Aggregate for o.amount" }), "sum");
  await user.type(screen.getByRole("textbox", { name: "Alias for o.amount" }), "total");
  await user.click(screen.getByRole("button", { name: "Add row count" }));
  await user.type(screen.getByRole("textbox", { name: "Alias for Row count" }), "orders");

  await user.type(screen.getByRole("textbox", { name: "New parameter name" }), "min_amount");
  await user.click(screen.getByRole("button", { name: "Add parameter" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Type of min_amount" }), "number");
  await user.type(screen.getByRole("textbox", { name: "Default for min_amount" }), "6");

  await user.click(screen.getByRole("button", { name: "Add filter" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Filter 1 column" }), "o.amount");
  await user.selectOptions(screen.getByRole("combobox", { name: "Filter 1 operator" }), ">=");
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Filter 1 compares with" }),
    "param",
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Filter 1 parameter" }),
    "min_amount",
  );

  await user.click(screen.getByRole("button", { name: "Add sort" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Sort 1 field" }), "sum(o.amount)");
  await user.selectOptions(screen.getByRole("combobox", { name: "Sort 1 direction" }), "desc");

  await gridRows("Preview", [
    ["Bolt", "50", "1"],
    ["ACME", "40", "2"],
  ]);

  await user.click(screen.getByRole("tab", { name: "SQL" }));
  expect(screen.getByLabelText("Generated SQL")).toHaveTextContent(
    'INNER JOIN "customers" AS "c" ON "o"."customer_id" = "c"."id"',
  );
  expect(screen.getByLabelText("Generated SQL")).toHaveTextContent('"o"."amount" >= $min_amount');
  await user.click(screen.getByRole("tab", { name: "Builder" }));

  const name = screen.getByRole("textbox", { name: "Query name" });
  await user.clear(name);
  await user.type(name, "Customer totals");
  await user.click(screen.getByRole("button", { name: "Save query" }));
  expect(await screen.findByRole("button", { name: "Customer totals" }, LONG)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const [saved] = (await readConfig()).savedQueries;
  expect(saved).toMatchObject({
    name: "Customer totals",
    parameters: [{ name: "min_amount", logicalType: "number", defaultValue: "6" }],
  });
  expect(saved.builder?.sources.map((s) => s.alias)).toEqual(["o", "c"]);
  expect(saved.sql).toContain('GROUP BY "c"."name"');

  await user.click(screen.getByRole("button", { name: "New query" }));
  expect(screen.queryByRole("checkbox", { name: "o.amount" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Customer totals" }));
  expect(await screen.findByRole("checkbox", { name: "o.amount" }, LONG)).toBeChecked();
  expect(screen.getByRole("combobox", { name: "Aggregate for o.amount" })).toHaveValue("sum");

  await user.type(screen.getByRole("textbox", { name: "Value for min_amount" }), "20");
  await user.click(screen.getByRole("button", { name: "Run" }));
  await gridRows("Preview", [
    ["Bolt", "50", "1"],
    ["ACME", "30", "1"],
  ]);

  const result = await invoke<{ columns: string[]; rows: unknown[][]; truncated: boolean }>(
    "run_saved_query",
    {
      windowLabel: "main",
      id: saved.id,
      params: [{ column: "min_amount", value: value("real", 40) }],
    },
  );
  expect(result.columns).toEqual(["name", "total", "orders"]);
  expect(result.rows).toEqual([[value("text", "Bolt"), value("real", 50), value("integer", 1)]]);
  expect(result.truncated).toBe(false);
});

it("saves SQL with a required parameter and rejects mutating SQL on save", async () => {
  const user = await openQueryMode();
  await user.click(screen.getByRole("button", { name: "New query" }));
  await user.click(screen.getByRole("tab", { name: "SQL" }));
  const editor = await screen.findByRole("textbox", { name: "SQL editor" });
  await user.click(editor);
  await user.paste("SELECT name FROM customers WHERE id >= $min ORDER BY id");
  expect(await screen.findByText("SQL", { selector: "b" })).toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "Declare $min" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Type of min" }), "integer");
  await user.click(screen.getByRole("checkbox", { name: "Required min" }));
  const name = screen.getByRole("textbox", { name: "Query name" });
  await user.clear(name);
  await user.type(name, "Customers from");
  await user.click(screen.getByRole("button", { name: "Save query" }));
  await screen.findByRole("button", { name: "Customers from" }, LONG);
  expect((await readConfig()).savedQueries[0]).toMatchObject({
    sql: "SELECT name FROM customers WHERE id >= $min ORDER BY id",
    builder: null,
    parameters: [{ name: "min", logicalType: "integer", required: true }],
  });

  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByRole("alert", {}, LONG)).toHaveTextContent(/\$min is required/);
  await user.type(screen.getByRole("textbox", { name: "Value for min" }), "2");
  await user.click(screen.getByRole("button", { name: "Run" }));
  await gridRows("Results", [["Bolt"], ["Core"]]);

  await user.clear(editor);
  await user.paste("DELETE FROM customers");
  await user.click(screen.getByRole("button", { name: "Save query" }));
  const alert = await screen.findByRole("alert", {}, LONG);
  expect(alert).toHaveTextContent(/read-only/);
  expect(alert).toHaveTextContent(/migration/);
  expect((await readConfig()).savedQueries[0].sql).toContain("SELECT");

  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Duplicate Customers from" }));
  expect(
    await screen.findByRole("button", { name: "Customers from copy" }, LONG),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Rename Customers from copy" }));
  const rename = screen.getByRole("textbox", { name: "New name for Customers from copy" });
  await user.clear(rename);
  await user.type(rename, "Second{Enter}");
  expect(await screen.findByRole("button", { name: "Second" }, LONG)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Delete Second" }));
  await waitFor(
    async () =>
      expect((await readConfig()).savedQueries.map((q) => q.name)).toEqual(["Customers from"]),
    LONG,
  );
});

it("saves parameterized SQL through save_query without parameter values", async () => {
  await openQueryMode();
  const config = await invoke<Config>("save_query", {
    windowLabel: "main",
    id: null,
    name: "Since",
    sql: "SELECT name FROM customers WHERE id >= $min AND name <> 'Delete; me';",
    filterState: null,
  });
  expect(config.savedQueries.map((q) => q.name)).toContain("Since");
});

it("shows progress and a Cancel button for a long query, and cancels it", async () => {
  const user = await openQueryMode();
  await user.click(screen.getByRole("button", { name: "New query" }));
  await user.click(screen.getByRole("tab", { name: "SQL" }));
  const editor = await screen.findByRole("textbox", { name: "SQL editor" });
  await user.click(editor);
  await user.paste(
    "SELECT count(*) FROM range(100000000) a CROSS JOIN range(100000) b WHERE a.range + b.range < 0",
  );
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByText(/Running query/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel query" })).not.toBeInTheDocument();
  const cancel = await screen.findByRole("button", { name: "Cancel query" }, { timeout: 10_000 });
  expect(screen.getByRole("progressbar", { name: "Query progress" })).toBeInTheDocument();
  await user.click(cancel);
  expect(await screen.findByRole("alert", {}, LONG)).toHaveTextContent("Query cancelled.");
}, 60_000);

it("joins on several conditions with an outer join, groups by and sorts on fields that are not output", async () => {
  const user = await openQueryMode();
  await user.click(screen.getByRole("button", { name: "New query" }));
  await user.selectOptions(await screen.findByRole("combobox", { name: "Source table" }), "orders");
  await user.click(
    await screen.findByRole(
      "button",
      { name: "Join customers on o.customer_id = customers.id" },
      LONG,
    ),
  );
  const kind = screen.getByRole("combobox", { name: "Join type for c" });
  expect(
    within(kind)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["Inner join", "Left join", "Right join", "Full outer join"]);
  await user.selectOptions(kind, "right");
  await user.click(screen.getByRole("button", { name: "Add condition to c" }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Join c left column 2" }),
    "o.customer_id",
  );
  await user.selectOptions(screen.getByRole("combobox", { name: "Join c right column 2" }), "id");
  await user.click(screen.getByRole("button", { name: "Add condition to c" }));
  await user.click(screen.getByRole("button", { name: "Remove join c condition 3" }));
  expect(screen.queryByRole("combobox", { name: "Join c left column 3" })).toBeNull();

  await user.click(await screen.findByRole("checkbox", { name: "c.name" }, LONG));
  await user.click(screen.getByRole("checkbox", { name: "o.amount" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Aggregate for o.amount" }), "sum");
  await user.click(screen.getByRole("checkbox", { name: "c.id" }));
  await user.click(screen.getByRole("checkbox", { name: "Output c.id" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Group by column" }), "c.id");
  await user.click(screen.getByRole("button", { name: "Add group by" }));
  expect(screen.getByRole("list", { name: "Group by columns" })).toHaveTextContent("c.id");
  await user.click(screen.getByRole("button", { name: "Add sort" }));
  await user.selectOptions(screen.getByRole("combobox", { name: "Sort 1 field" }), "c.id");
  await user.selectOptions(screen.getByRole("combobox", { name: "Sort 1 direction" }), "desc");

  await gridRows("Preview", [
    ["Core", "1"],
    ["Bolt", "55"],
    ["ACME", "40"],
  ]);
  await user.click(screen.getByRole("tab", { name: "SQL" }));
  const sql = screen.getByLabelText("Generated SQL");
  expect(sql).toHaveTextContent(
    'RIGHT JOIN "customers" AS "c" ON "o"."customer_id" = "c"."id" AND "o"."customer_id" = "c"."id"',
  );
  expect(sql).toHaveTextContent('GROUP BY "c"."id", "c"."name"');
  expect(sql).toHaveTextContent('ORDER BY "c"."id" DESC');
  expect(sql).not.toHaveTextContent('"c"."id" AS');
});
