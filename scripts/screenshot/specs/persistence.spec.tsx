import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import App from "../../../src/App";
import { captureDocument } from "../capture";
import {
  createTable,
  dialogMock,
  LONG,
  openSettingsTab,
  refreshDatabase,
  renderNewDocument,
  saveAs,
  seedSales,
  tempPath,
} from "./fixtures";

it("saves, autosaves, closes, and reopens a document from the recent list", async () => {
  const user = await renderNewDocument();
  await seedSales();
  const path = await saveAs(user, "orders-app.ixt");
  const status = screen.getByRole("group", { name: "Save status" });
  expect(status).toHaveTextContent(/Saved at/);

  await createTable("returns", [{ name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 }]);
  await refreshDatabase();
  await waitFor(() => expect(status).toHaveTextContent("Unsaved changes"), LONG);
  await waitFor(() => expect(status).toHaveTextContent(/Saved at/), LONG);
  expect((await invoke<{ dirty: boolean }>("document_state", { windowLabel: "main" })).dirty).toBe(
    false,
  );
  await captureDocument(document, {
    name: "persistence-01-autosaved",
    expectations: [
      "The sidebar shows the archive name and a 'Saved at' status after the autosave.",
      "The new returns table is listed in the object browser.",
    ],
  });

  await user.click(screen.getByRole("button", { name: "Close project" }));
  const recent = await screen.findByRole("button", { name: /^Open recent orders-app/ }, LONG);
  await captureDocument(document, {
    name: "persistence-02-recent",
    expectations: ["The start screen lists orders-app.ixt under Recent documents with its path."],
  });
  await user.click(recent);
  expect(await screen.findByText("Saved archive", {}, LONG)).toBeInTheDocument();
  expect((await invoke<{ path: string }>("document_state", { windowLabel: "main" })).path).toBe(
    path,
  );
});

it("offers to recover unsaved work after a crash", async () => {
  await invoke("new_document", { windowLabel: "crashy" });
  const config = await invoke<Record<string, unknown>>("read_document_config", {
    windowLabel: "crashy",
  });
  await invoke("update_document_config", {
    windowLabel: "crashy",
    config: { ...config, name: "Field notes" },
  });
  await invoke("save_document_as", { windowLabel: "crashy", path: tempPath("field-notes.ixt") });
  await invoke("create_database_table", {
    windowLabel: "crashy",
    spec: {
      name: "notes",
      columns: [
        {
          name: "id",
          declaredType: "INTEGER",
          nullable: false,
          primaryKeyPosition: 1,
          unique: false,
          defaultExpression: null,
          generatedExpression: null,
        },
      ],
      foreignKeys: [],
      checks: [],
      withoutRowid: false,
    },
  });
  await invoke("simulate_crash", { windowLabel: "crashy" });

  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole("heading", { name: "Recover unsaved work" }, LONG);
  await captureDocument(document, {
    name: "persistence-03-recovery-prompt",
    expectations: [
      "The start screen shows a Recover unsaved work section naming Field notes.",
      "Recover and Discard actions are offered for the crashed session.",
    ],
  });
  await user.click(screen.getByRole("button", { name: "Recover Field notes" }));
  expect(await screen.findByText("Saved archive", {}, LONG)).toBeInTheDocument();
  await screen.findByRole("button", { name: /^notes\b/ }, LONG);
});

it("imports assets and reports archive size, checkpoints, and logs", async () => {
  const user = await renderNewDocument();
  await seedSales();
  await openSettingsTab(user, "Assets");
  const dir = mkdtempSync(join(tempPath(""), "assets-"));
  const logo = join(dir, "logo.png");
  writeFileSync(logo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  const manual = join(dir, "handbook.pdf");
  writeFileSync(manual, Buffer.alloc(180_000, 7));
  for (const file of [logo, manual]) {
    dialogMock.open.mockResolvedValueOnce(file);
    await user.click(screen.getByRole("button", { name: "Import asset" }));
    await screen.findByText(`Imported ${file.split("/").pop()}.`, {}, LONG);
  }
  const table = await screen.findByRole("table", { name: "Assets" }, LONG);
  expect(within(table).getAllByRole("row")).toHaveLength(3);
  const size = await screen.findByRole("region", { name: "Archive size" }, LONG);
  await waitFor(
    () =>
      expect(within(size).getByRole("list", { name: "Largest archive entries" })).toHaveTextContent(
        "handbook.pdf",
      ),
    LONG,
  );
  const checkpoints = screen.getByRole("region", { name: "Checkpoints" });
  await user.click(within(checkpoints).getByRole("button", { name: "Create checkpoint" }));
  await within(checkpoints).findByText("Checkpoint created.", {}, LONG);
  await captureDocument(document, {
    name: "assets-01-assets-and-size",
    expectations: [
      "The Assets table lists logo.png and handbook.pdf with MIME type, size, and actions.",
      "Archive size breaks the archive into Records, Configuration, Assets, and Other against the 500 MB limit.",
      "The Checkpoints panel lists one manual checkpoint with a restore action.",
    ],
  });

  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("tab", { name: "Logs" }));
  await screen.findByRole("list", { name: "Log entries" }, LONG);
  await captureDocument(document, {
    name: "settings-06-logs",
    expectations: ["The Logs tab lists timestamped, levelled diagnostic lines with a Copy action."],
  });
});
