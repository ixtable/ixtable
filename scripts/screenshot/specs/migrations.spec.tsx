import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { captureDocument } from "../capture";
import { createTable, LONG, openSettingsTab, renderNewDocument, type User } from "./fixtures";

type Config = {
  design: { forms: Array<Record<string, unknown>> };
  migrations: Array<Record<string, unknown>>;
};

async function loadConfig(user: User, edit: (config: Config) => void) {
  const config = await invoke<Config>("read_document_config", { windowLabel: "main" });
  edit(config);
  await openSettingsTab(user, "Migrations");
  await invoke("update_document_config", { windowLabel: "main", config });
  await user.click(screen.getByRole("tab", { name: "Datasource" }));
  await user.click(screen.getByRole("tab", { name: "Migrations" }));
  await screen.findByRole("heading", { name: "Migrations" }, LONG);
}

it("lists problems after a migration and refuses a dry run that fails preflight", async () => {
  const user = await renderNewDocument();
  await createTable("items", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "label", declaredType: "TEXT" },
  ]);
  await loadConfig(user, (config) => {
    config.design.forms[0].source = { kind: "table", table: "items" };
    config.design.forms[0].controls = [
      { id: crypto.randomUUID(), kind: "text", label: "Item label", binding: { column: "label" } },
    ];
    config.migrations = [
      { id: "m-drop", name: "Drop label", order: 1, up: "ALTER TABLE items DROP COLUMN label;" },
    ];
  });
  await screen.findByRole("cell", { name: "Drop label" }, LONG);
  await user.click(await screen.findByRole("button", { name: "Apply pending (1)" }, LONG));
  const problems = await screen.findByRole("region", { name: "Problems after migration" }, LONG);
  expect(within(problems).getByText(/"Item label" is bound to items\.label/)).toBeInTheDocument();
  const log = screen.getByRole("region", { name: "Migration log" });
  await within(log).findByText(/Health passed: .*integrity_check: ok/, {}, LONG);
  await captureDocument(document, {
    name: "migrations-01-problems-after",
    expectations: [
      "A 'Problems after migration' panel says the Item label control is bound to the dropped items.label.",
      "The migration log shows the run succeeded with a passed health check.",
    ],
  });

  await loadConfig(user, (config) => {
    config.migrations = [
      { id: "m-drop", name: "Drop label", order: 1, up: "ALTER TABLE items DROP COLUMN id;" },
      { id: "m-tags", name: "Add tags", order: 2, up: "CREATE TABLE tags (id INTEGER);" },
    ];
  });
  await screen.findByRole("cell", { name: "Changed after apply" }, LONG);
  const dryRun = screen.getByRole("button", { name: "Dry run pending" });
  await waitFor(() => expect(dryRun).toBeEnabled(), LONG);
  await user.click(dryRun);
  expect(await screen.findByRole("alert", {}, LONG)).toHaveTextContent(
    /Drop label changed after it was applied/,
  );
  expect(screen.queryByText("Dry run succeeded; nothing was changed.")).toBeNull();
  expect(screen.getByRole("button", { name: "Apply pending (1)" })).toBeDisabled();
  await captureDocument(document, {
    name: "migrations-02-dry-run-preflight-error",
    expectations: [
      "Drop label is marked 'Changed after apply' and Add tags is pending in the migration list.",
      "The dry run shows an error that Drop label changed after it was applied; nothing ran.",
      "'Apply pending (1)' is disabled after the failed dry run.",
    ],
  });
});
