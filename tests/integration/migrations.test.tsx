import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { renderNewDocument } from "./helpers";

const LONG = { timeout: 20_000 };

async function openMigrations(user: Awaited<ReturnType<typeof renderNewDocument>>) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: "Migrations" }));
  await screen.findByRole("heading", { name: "Migrations" }, LONG);
}
const objects = () =>
  invoke<Array<{ name: string }>>("list_database_objects", { windowLabel: "main" }).then((all) =>
    all.map((o) => o.name),
  );

async function clickWhenEnabled(user: Awaited<ReturnType<typeof renderNewDocument>>, name: string) {
  const button = await screen.findByRole("button", { name }, LONG);
  await waitFor(() => expect(button).toBeEnabled(), LONG);
  await user.click(button);
}

async function author(
  user: Awaited<ReturnType<typeof renderNewDocument>>,
  name: string,
  up: string,
  down?: string,
) {
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

it("dry-runs, applies with a checkpoint, logs, and rolls back a reversible migration", async () => {
  const user = await renderNewDocument();
  await openMigrations(user);
  await author(
    user,
    "Create audit",
    "CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT NOT NULL);",
    "DROP TABLE audit;",
  );

  await clickWhenEnabled(user, "Dry run pending");
  expect(
    await screen.findByText("Dry run succeeded; nothing was changed.", {}, LONG),
  ).toBeInTheDocument();
  expect(await objects()).not.toContain("audit");

  await clickWhenEnabled(user, "Apply pending (1)");
  const status = await screen.findByText(
    /All migrations succeeded\. Checkpoint .* was saved first\./,
    {},
    LONG,
  );
  expect(status).toBeInTheDocument();
  expect(await objects()).toContain("audit");
  expect((await objects()).some((name) => name.startsWith("_ixtable_"))).toBe(false);
  const log = screen.getByRole("region", { name: "Migration log" });
  expect(await within(log).findByText("applied", {}, LONG)).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "Applied" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Edit Create audit" }));
  const editor = await screen.findByRole("region", { name: /Edit migration/ }, LONG);
  expect(within(editor).getByRole("textbox", { name: "Up SQL" })).toHaveAttribute("readonly");
  await user.click(within(editor).getByRole("button", { name: "Preview SQL" }));
  expect(
    await within(editor).findByText(/1 statement on sqlite, in one transaction/, {}, LONG),
  ).toBeInTheDocument();
  await user.click(within(editor).getByRole("button", { name: "Close" }));

  await clickWhenEnabled(user, "Roll back last");
  await waitFor(async () => expect(await objects()).not.toContain("audit"), LONG);
  expect(await within(log).findByText("rolled_back", {}, LONG)).toBeInTheDocument();
});

it("stops on a failing migration, rolls it back, and shows recovery instructions", async () => {
  const user = await renderNewDocument();
  await openMigrations(user);
  await author(
    user,
    "Make items",
    "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);",
  );
  await author(
    user,
    "Broken seed",
    "INSERT INTO items (label) VALUES ('ok'); INSERT INTO items (label) VALUES (NULL);",
  );

  await clickWhenEnabled(user, "Dry run pending");
  expect(
    await screen.findByText("Dry run failed; nothing was changed.", {}, LONG),
  ).toBeInTheDocument();

  await clickWhenEnabled(user, "Apply pending (2)");
  expect(
    await screen.findByText(/A migration failed; later ones did not run\./, {}, LONG),
  ).toBeInTheDocument();
  const run = screen.getByRole("region", { name: "Last run" });
  expect(within(run).getByText(/Not null constraint failed/)).toBeInTheDocument();
  expect(
    within(run).getByText(/Recovery: "Broken seed" failed and its transaction was rolled back/),
  ).toBeInTheDocument();
  const rows = await invoke<{ total: number }>("read_table_page", {
    windowLabel: "main",
    table: "items",
    offset: 0,
    limit: 10,
    sorts: [],
    filters: [],
  });
  expect(rows.total).toBe(0);
  expect(await screen.findByRole("button", { name: "Apply pending (1)" }, LONG)).toBeEnabled();
});

const readConfig = () =>
  invoke<Record<string, unknown>>("read_document_config", { windowLabel: "main" });
async function setConfig(
  user: Awaited<ReturnType<typeof renderNewDocument>>,
  patch: Record<string, unknown>,
) {
  await openMigrations(user);
  await invoke("update_document_config", {
    windowLabel: "main",
    config: { ...(await readConfig()), ...patch },
  });
  await user.click(screen.getByRole("tab", { name: "Datasource" }));
  await user.click(screen.getByRole("tab", { name: "Migrations" }));
  await screen.findByRole("heading", { name: "Migrations" }, LONG);
}
const failureOf = (command: string) =>
  invoke(command, { windowLabel: "main" }).then(
    () => "succeeded",
    (e: unknown) => String((e as Error).message ?? e),
  );

it("flags a legacy PostgreSQL-target migration and refuses to apply it", async () => {
  const user = await renderNewDocument();
  await setConfig(user, {
    migrations: [
      { id: "m-pg", name: "Old PG change", order: 1, targetStore: "postgres", up: "SELECT 1" },
    ],
  });
  expect(
    await screen.findByText(
      "Old PG change: PostgreSQL migrations are not supported in this version; manage external database schema yourself",
      {},
      LONG,
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "PostgreSQL (not supported)" })).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "Not supported" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Apply pending (0)" })).toBeDisabled();
  await expect(failureOf("apply_migrations")).resolves.toMatch(/PostgreSQL migrations are not/);

  await user.click(screen.getByRole("button", { name: "Edit Old PG change" }));
  const editor = await screen.findByRole("region", { name: /Edit migration/ }, LONG);
  await user.selectOptions(within(editor).getByRole("combobox", { name: "Target store" }), "sqlite");
  await user.click(within(editor).getByRole("button", { name: "Save migration" }));
  await clickWhenEnabled(user, "Apply pending (1)");
  expect(await screen.findByText(/All migrations succeeded\./, {}, LONG)).toBeInTheDocument();
});

it("disables migrations for a document whose datasource is PostgreSQL", async () => {
  const user = await renderNewDocument();
  await setConfig(user, {
    datasource: { kind: "postgres", host: "127.0.0.1", port: 1, database: "x", user: "x" },
    migrations: [{ id: "m1", name: "Create things", order: 1, up: "CREATE TABLE things (x)" }],
  });
  const note = await screen.findByRole("note", { name: "Migrations disabled" }, LONG);
  expect(note).toHaveTextContent(
    "Migrations apply to the embedded SQLite store only and are disabled for this document",
  );
  expect(await screen.findByRole("cell", { name: "Disabled" }, LONG)).toBeInTheDocument();
  for (const name of ["Dry run pending", "Apply pending (0)", "Roll back last"])
    expect(screen.getByRole("button", { name })).toBeDisabled();
  expect(screen.queryByRole("checkbox", { name: /PostgreSQL backup/ })).toBeNull();
  for (const command of ["apply_migrations", "rollback_migration", "dry_run_migrations"])
    await expect(failureOf(command)).resolves.toMatch(
      /VALIDATION_ERROR.*Migrations apply to the embedded SQLite store only/,
    );
});
