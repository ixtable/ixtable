import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { createTable, readPage, renderNewDocument, value } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };
type User = Awaited<ReturnType<typeof renderNewDocument>>;

function fixture(name: string, contents: string) {
  const dir = mkdtempSync(join(process.env.IXTABLE_STATE_DIR!, "import-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

async function openWizard(user: User, path: string) {
  await user.click(screen.getByRole("button", { name: "Import records" }));
  const dialog = await screen.findByRole("dialog", { name: "Import records" });
  dialogMock.open.mockResolvedValueOnce(path);
  await user.click(within(dialog).getByRole("button", { name: /Choose file/ }));
  await within(dialog).findByRole("table", { name: "File preview" }, LONG);
  return dialog;
}

const runQuery = (sql: string) =>
  invoke<{ columns: string[]; rows: unknown[][] }>("execute_parameterized_query", {
    windowLabel: "main",
    sql,
    params: [],
  });

it("imports a CSV into a new table with inferred types and a generated key", async () => {
  const user = await renderNewDocument();
  const dialog = await openWizard(
    user,
    fixture("Team Members.csv", "name;age;joined\nAda;36;2024-01-15\nGrace;45;2024-02-01\n"),
  );
  const preview = within(dialog).getByRole("table", { name: "File preview" });
  expect(within(preview).getByRole("columnheader", { name: "age integer" })).toBeInTheDocument();
  expect(within(preview).getByRole("columnheader", { name: "joined date" })).toBeInTheDocument();
  expect(within(dialog).getByText("2 rows · showing the first 2")).toBeInTheDocument();
  expect(within(dialog).getByRole("textbox", { name: "Table name" })).toHaveValue("team_members");
  expect(within(dialog).getByRole("combobox", { name: "Type for age" })).toHaveValue("integer");

  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  expect(
    await within(dialog).findByText("Imported 2 of 2 rows into team_members.", {}, LONG),
  ).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  const page = await readPage("team_members");
  expect(page.columns.map((c) => c.name)).toEqual(["id", "name", "age", "joined"]);
  expect(page.rows).toEqual([
    [
      value("integer", 1),
      value("text", "Ada"),
      value("integer", 36),
      { type: "date", value: "2024-01-15" },
    ],
    [
      value("integer", 2),
      value("text", "Grace"),
      value("integer", 45),
      { type: "date", value: "2024-02-01" },
    ],
  ]);
});

it("maps file columns onto an existing table and reports rows that fail checks", async () => {
  const user = await renderNewDocument();
  await createTable("members", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT", nullable: false },
    { name: "age", declaredType: "INTEGER" },
  ]);
  const dialog = await openWizard(
    user,
    fixture("people.csv", "Name,Age,Note\nAda,36,x\n,40,y\nLinus,abc,z\n"),
  );
  await user.click(within(dialog).getByRole("radio", { name: "An existing table" }));
  expect(within(dialog).getByRole("combobox", { name: "Field for Name" })).toHaveValue("name");
  expect(within(dialog).getByRole("combobox", { name: "Field for Age" })).toHaveValue("age");
  expect(within(dialog).getByRole("combobox", { name: "Field for Note" })).toHaveValue("");

  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  expect(
    await within(dialog).findByText(
      "Imported 1 of 3 rows into members. 2 rows were skipped.",
      {},
      LONG,
    ),
  ).toBeInTheDocument();
  const problems = within(dialog).getByRole("table", { name: "Rows not imported" });
  const rows = within(problems)
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );
  expect(rows).toEqual([
    ["2", "name", "name is required"],
    ["3", "age", "age requires an integer"],
  ]);
  const page = await readPage("members");
  expect(page.rows).toEqual([[value("integer", 1), value("text", "Ada"), value("integer", 36)]]);
});

it("imports an XLSX worksheet with dates and booleans", async () => {
  const user = await renderNewDocument();
  const dialog = await openWizard(user, resolve("tests/fixtures/imports/people.xlsx"));
  expect(within(dialog).getByRole("combobox", { name: "Worksheet" })).toHaveValue("People");
  expect(within(dialog).getByRole("combobox", { name: "Type for active" })).toHaveValue("boolean");
  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  expect(
    await within(dialog).findByText("Imported 3 of 3 rows into people.", {}, LONG),
  ).toBeInTheDocument();
  const page = await readPage("people");
  expect(page.rows[0]).toEqual([
    value("integer", 1),
    value("text", "Ada"),
    value("integer", 36),
    { type: "date", value: "2024-01-15" },
    value("boolean", true),
    value("real", 9.5),
  ]);
});

it("bundles a CSV as a read-only file source that queries read after save and reopen", async () => {
  const user = await renderNewDocument();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: "File sources" }));
  dialogMock.open.mockResolvedValueOnce(
    fixture("sales.csv", "region,amount\nnorth,10\nsouth,5\nnorth,2\n"),
  );
  await user.click(screen.getByRole("button", { name: "Add file source" }));
  expect(await screen.findByText(/3 rows · region \(text\), amount \(integer\)/, {}, LONG));
  expect(screen.getByRole("textbox", { name: "Source name" })).toHaveValue("sales");
  await user.click(screen.getByRole("button", { name: "Add source" }));
  expect(await screen.findByText("Added files.sales.", {}, LONG)).toBeInTheDocument();
  const table = screen.getByRole("table", { name: "File sources" });
  await waitFor(() => {
    const row = within(table).getByRole("row", { name: /files\.sales/ });
    expect(row).toHaveTextContent("region, amount");
    expect(row).toHaveTextContent("3");
  }, LONG);

  const sql =
    "SELECT region, sum(amount) AS total FROM files.sales GROUP BY region ORDER BY region";
  const expected = [
    [value("text", "north"), value("integer", 12)],
    [value("text", "south"), value("integer", 5)],
  ];
  expect((await runQuery(sql)).rows).toEqual(expected);
  await expect(runQuery("DELETE FROM files.sales")).rejects.toThrow();

  const path = join(mkdtempSync(join(process.env.IXTABLE_STATE_DIR!, "doc-")), "sales.ixt");
  await invoke("save_document_as", { windowLabel: "main", path });
  await invoke("close_document", { windowLabel: "main", force: true });
  await invoke("open_document", { windowLabel: "main", path });
  expect((await runQuery(sql)).rows).toEqual(expected);
});

it("imports a late bad value as a skipped row instead of failing the import", async () => {
  const user = await renderNewDocument();
  const lines = ["name,age"];
  for (let i = 1; i <= 22_005; i++) lines.push(`P${i},${i === 22_002 ? "n/a" : i % 90}`);
  const dialog = await openWizard(user, fixture("late.csv", `${lines.join("\n")}\n`));
  // The whole file is sniffed, so the column is suggested as text; ask for integers.
  const age = within(dialog).getByRole("combobox", { name: "Type for age" });
  expect(age).toHaveValue("text");
  await user.selectOptions(age, "integer");
  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  expect(
    await within(dialog).findByText(
      "Imported 22,004 of 22,005 rows into late. 1 rows were skipped.",
      {},
      LONG,
    ),
  ).toBeInTheDocument();
  const problems = within(dialog).getByRole("table", { name: "Rows not imported" });
  expect(within(problems).getByRole("row", { name: /22002/ })).toHaveTextContent(
    "age requires an integer",
  );
}, 120_000);

it("reports an import that stops part way and still lists the new table", async () => {
  const user = await renderNewDocument();
  const good = ["name,age"];
  for (let i = 1; i <= 24_000; i++) good.push(`P${i},${i % 90}`);
  const path = fixture("broken.csv", `${good.join("\n")}\n`);
  const dialog = await openWizard(user, path);
  // The file changes after the preview: a row near the end has too many fields.
  good.splice(22_000, 0, "X,1,extra,fields");
  writeFileSync(path, `${good.join("\n")}\n`);
  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  const stopped = await within(dialog).findByText(/^The import stopped after/, {}, LONG);
  expect(stopped).toHaveTextContent(/Could not read the file/);
  // The created table is reloaded even though the import did not finish.
  await within(dialog).findByText(/^Imported [\d,]+ of [\d,]+ rows into broken\./);
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(await screen.findByRole("button", { name: /^broken\b/ }, LONG)).toBeInTheDocument();
}, 120_000);
