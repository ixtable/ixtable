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
