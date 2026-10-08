import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { createTable, renderNewDocument } from "./helpers";

const LONG = { timeout: 20_000 };
type User = Awaited<ReturnType<typeof renderNewDocument>>;

async function openMigrations(user: User) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: "Migrations" }));
  await screen.findByRole("heading", { name: "Migrations" }, LONG);
}

async function author(user: User, name: string, up: string, down?: string) {
  await user.click(screen.getByRole("button", { name: "New migration" }));
  const editor = await screen.findByRole("region", { name: /Edit migration/ }, LONG);
  const nameBox = within(editor).getByRole("textbox", { name: "Name" });
  await user.clear(nameBox);
  await user.type(nameBox, name);
  await user.click(within(editor).getByRole("textbox", { name: "Up SQL" }));
  await user.paste(up);
  if (down) {
    await user.click(within(editor).getByRole("checkbox", { name: /Reversible/ }));
    await user.click(within(editor).getByRole("textbox", { name: "Down SQL" }));
    await user.paste(down);
  }
  await user.click(within(editor).getByRole("button", { name: "Save migration" }));
  await screen.findByRole("cell", { name }, LONG);
}

async function applyPending(user: User, count: number) {
  const button = await screen.findByRole("button", { name: `Apply pending (${count})` }, LONG);
  await user.click(button);
}

it("previews the down SQL of a reversible migration", async () => {
  const user = await renderNewDocument();
  await openMigrations(user);
  await author(user, "Add audit", "CREATE TABLE audit (id INTEGER);", "DROP TABLE audit;");
  await user.click(screen.getByRole("button", { name: "Edit Add audit" }));
  const editor = await screen.findByRole("region", { name: /Edit migration/ }, LONG);
  await user.click(within(editor).getByRole("button", { name: "Preview down SQL" }));
  const preview = await within(editor).findByLabelText("SQL preview (down)", {}, LONG);
  expect(within(preview).getByText("DROP TABLE audit;")).toBeInTheDocument();
});

it("shows health results and times in the log, and problems after a migration drops a bound column", async () => {
  const user = await renderNewDocument();
  await createTable("items", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "label", declaredType: "TEXT" },
  ]);
  const config = await invoke<{
    design: { forms: Array<Record<string, unknown>> };
    migrations: unknown[];
  }>("read_document_config", { windowLabel: "main" });
  config.design.forms[0].source = { kind: "table", table: "items" };
  config.design.forms[0].controls = [
    { id: crypto.randomUUID(), kind: "text", label: "Item label", binding: { column: "label" } },
  ];
  config.migrations = [
    { id: "m-drop", name: "Drop label", order: 1, up: "ALTER TABLE items DROP COLUMN label;" },
  ];
  await openMigrations(user);
  await invoke("update_document_config", { windowLabel: "main", config });
  await user.click(screen.getByRole("tab", { name: "Datasource" }));
  await user.click(screen.getByRole("tab", { name: "Migrations" }));
  await screen.findByRole("heading", { name: "Migrations" }, LONG);
  await screen.findByRole("cell", { name: "Drop label" }, LONG);
  await applyPending(user, 1);

  const problems = await screen.findByRole("region", { name: "Problems after migration" }, LONG);
  expect(within(problems).getByText(/"Item label" is bound to items\.label/)).toBeInTheDocument();

  const log = screen.getByRole("region", { name: "Migration log" });
  expect(
    await within(log).findByText(/Health passed: .*integrity_check: ok/, {}, LONG),
  ).toBeInTheDocument();
});

type Config = {
  design: { forms: Array<Record<string, unknown>> };
  migrations: Array<Record<string, unknown>>;
};
async function loadConfig(user: User, edit: (config: Config) => void) {
  const config = await invoke<Config>("read_document_config", { windowLabel: "main" });
  edit(config);
  await openMigrations(user);
  await invoke("update_document_config", { windowLabel: "main", config });
  await user.click(screen.getByRole("tab", { name: "Datasource" }));
  await user.click(screen.getByRole("tab", { name: "Migrations" }));
  await screen.findByRole("heading", { name: "Migrations" }, LONG);
}

it("lists only problems the migration introduced and hides them after a failed run", async () => {
  const user = await renderNewDocument();
  await createTable("items", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "label", declaredType: "TEXT" },
  ]);
  await loadConfig(user, (config) => {
    config.design.forms[0].source = { kind: "table", table: "items" };
    config.design.forms[0].controls = [
      { id: crypto.randomUUID(), kind: "text", label: "Item label", binding: { column: "label" } },
      { id: crypto.randomUUID(), kind: "text", label: "Old ghost", binding: { column: "ghost" } },
    ];
    config.migrations = [
      { id: "m-drop", name: "Drop label", order: 1, up: "ALTER TABLE items DROP COLUMN label;" },
    ];
  });
  await screen.findByRole("cell", { name: "Drop label" }, LONG);
  await applyPending(user, 1);
  const problems = await screen.findByRole("region", { name: "Problems after migration" }, LONG);
  expect(within(problems).getByText(/"Item label" is bound to items\.label/)).toBeInTheDocument();
  expect(within(problems).queryByText(/Old ghost/)).toBeNull();

  await loadConfig(user, (config) => {
    config.migrations.push({
      id: "m-broken",
      name: "Broken",
      order: 2,
      up: "INSERT INTO nowhere VALUES (1);",
    });
  });
  await screen.findByRole("cell", { name: "Broken" }, LONG);
  expect(screen.queryByRole("region", { name: "Problems after migration" })).toBeNull();
  await applyPending(user, 1);
  expect(
    await screen.findByText(/A migration failed; later ones did not run\./, {}, LONG),
  ).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Problems after migration" })).toBeNull();
});

it("dry run refuses what apply refuses, such as an edited applied migration", async () => {
  const user = await renderNewDocument();
  await loadConfig(user, (config) => {
    config.migrations = [{ id: "m-a", name: "Make a", order: 1, up: "CREATE TABLE a (x);" }];
  });
  await applyPending(user, 1);
  await screen.findByText(/All migrations succeeded\./, {}, LONG);
  await loadConfig(user, (config) => {
    config.migrations = [
      { id: "m-a", name: "Make a", order: 1, up: "CREATE TABLE a (y);" },
      { id: "m-b", name: "Make b", order: 2, up: "CREATE TABLE b (x);" },
    ];
  });
  await screen.findByRole("cell", { name: "Changed after apply" }, LONG);
  const button = screen.getByRole("button", { name: "Dry run pending" });
  await waitFor(() => expect(button).toBeEnabled(), LONG);
  await user.click(button);
  expect(await screen.findByRole("alert", {}, LONG)).toHaveTextContent(
    /Make a changed after it was applied/,
  );
  expect(screen.queryByText("Dry run succeeded; nothing was changed.")).toBeNull();
  expect(screen.getByRole("button", { name: /^Apply pending/ })).toBeDisabled();
});
