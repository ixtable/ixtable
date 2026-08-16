import { screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { createTable, insertRow, renderNewDocument, value } from "./helpers";

it("executes typed read SQL and rejects write SQL through the visible workspace", async () => {
  const user = await renderNewDocument();
  await createTable("metrics", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "label", declaredType: "TEXT" },
  ]);
  await insertRow("metrics", [
    { column: "id", value: value("integer", 7) },
    { column: "label", value: value("text", "seven") },
  ]);
  await user.click(screen.getByRole("button", { name: "New query" }));
  const editor = await screen.findByRole("textbox", { name: "SQL editor" });
  await user.clear(editor);
  await user.type(editor, "SELECT id, label FROM metrics");
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByText("seven")).toBeInTheDocument();
  expect(screen.getByText("7")).toBeInTheDocument();

  await user.clear(editor);
  await user.type(editor, "DELETE FROM metrics");
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/read-only/i);
  const persisted = await invoke<{ rows: unknown[][] }>("execute_read_query", {
    windowLabel: "main",
    sql: "SELECT id FROM metrics",
  });
  expect(persisted.rows).toHaveLength(1);
});

it("persists saved-query metadata through public commands", async () => {
  await renderNewDocument();
  const saved = await invoke<{ savedQueries: Array<{ id: string; name: string; sql: string }> }>(
    "save_query",
    {
      windowLabel: "main",
      id: null,
      name: "All values",
      sql: "SELECT 42 AS value",
      filterState: null,
    },
  );
  expect(saved.savedQueries[0]).toMatchObject({ name: "All values", sql: "SELECT 42 AS value" });
  const id = saved.savedQueries[0].id;
  await invoke("save_query", {
    windowLabel: "main",
    id,
    name: "Renamed",
    sql: "SELECT 43 AS value",
    filterState: null,
  });
  const reloaded = await invoke<{ savedQueries: Array<{ id: string; name: string }> }>(
    "read_document_config",
    { windowLabel: "main" },
  );
  expect(reloaded.savedQueries).toEqual([expect.objectContaining({ id, name: "Renamed" })]);
  const deleted = await invoke<{ savedQueries: unknown[] }>("delete_saved_query", {
    windowLabel: "main",
    id,
  });
  expect(deleted.savedQueries).toEqual([]);
});
