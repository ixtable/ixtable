import { screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { renderNewDocument } from "./helpers";

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MiniMap: () => null,
  Position: { Left: "left", Right: "right" },
  ReactFlow: ({ children }: { children: ReactNode }) => children,
}));

async function renderSettledDocument() {
  const user = await renderNewDocument();
  await screen.findByRole("status", {}, { timeout: 20_000 });
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  return user;
}

it("executes typed read SQL and rejects write SQL through the visible workspace", async () => {
  const user = await renderSettledDocument();
  await user.click(screen.getByRole("button", { name: "New query" }));
  const editor = await screen.findByRole("textbox", { name: "SQL editor" });
  await user.clear(editor);
  await user.type(editor, "SELECT 7 AS id, 'seven' AS label");
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByText("seven")).toBeInTheDocument();
  expect(screen.getByText("7")).toBeInTheDocument();

  await user.clear(editor);
  await user.type(editor, "DELETE FROM imaginary_table");
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/read-only/i);
  const persisted = await invoke<{ rows: unknown[][] }>("execute_read_query", {
    windowLabel: "main",
    sql: "SELECT 7 AS id",
  });
  expect(persisted.rows).toHaveLength(1);
});

it("persists saved-query metadata through public commands", async () => {
  await invoke("new_document", { windowLabel: "main" });
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

it("creates, saves, runs, and updates a query through the visible workspace", async () => {
  const user = await renderSettledDocument();
  await user.click(screen.getByRole("button", { name: "New query" }));

  const name = await screen.findByRole("textbox", { name: "Query name" });
  const editor = screen.getByRole("textbox", { name: "SQL editor" });
  await user.clear(name);
  await user.type(name, "Initial value");
  await user.clear(editor);
  await user.type(editor, "SELECT 42 AS value");
  await user.click(screen.getByRole("button", { name: "Save query" }));

  const initialSidebarQuery = await screen.findByRole("button", { name: "Initial value" });
  expect(initialSidebarQuery).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByText("42")).toBeInTheDocument();

  await user.clear(name);
  await user.type(name, "Updated value");
  await user.clear(editor);
  await user.type(editor, "SELECT 84 AS value");
  await user.click(screen.getByRole("button", { name: "Save query" }));

  expect(await screen.findByRole("button", { name: "Updated value" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Initial value" })).not.toBeInTheDocument();
  const config = await invoke<{ savedQueries: Array<{ id: string; name: string; sql: string }> }>(
    "read_document_config",
    { windowLabel: "main" },
  );
  expect(config.savedQueries).toHaveLength(1);
  expect(config.savedQueries[0]).toMatchObject({
    name: "Updated value",
    sql: "SELECT 84 AS value",
  });

  await user.click(screen.getByRole("button", { name: "New query" }));
  await user.click(screen.getByRole("button", { name: "Updated value" }));
  await waitFor(() => expect(editor).toHaveValue("SELECT 84 AS value"));
  expect(name).toHaveValue("Updated value");
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByText("84")).toBeInTheDocument();
});
