import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import App from "../../src/App";
import { createTable, readPage, renderNewDocument } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };
const state = (windowLabel = "main") =>
  invoke<{
    dirty: boolean;
    path: string | null;
    workspace: string;
    sessionId: string;
    lastSavedAt: string | null;
    lastError: { code: string; message: string } | null;
  }>("document_state", { windowLabel });
const archivePath = (name: string) =>
  join(process.env.IXTABLE_STATE_DIR!, `${name}-${Math.random().toString(36).slice(2)}.ixt`);

async function seedCrashedSession(window: string, name: string, path: string | null) {
  await invoke("new_document", { windowLabel: window });
  const config = await invoke<Record<string, unknown>>("read_document_config", {
    windowLabel: window,
  });
  await invoke("update_document_config", { windowLabel: window, config: { ...config, name } });
  if (path) await invoke("save_document_as", { windowLabel: window, path });
  await invoke("create_database_table", {
    windowLabel: window,
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
  await invoke("insert_row", {
    windowLabel: window,
    table: "notes",
    values: [{ column: "id", value: { type: "integer", value: 7 } }],
  });
  const crashed = await state(window);
  expect(crashed.dirty).toBe(true);
  await invoke("simulate_crash", { windowLabel: window });
  return crashed;
}

function renderStartScreen() {
  const events = userEvent.setup();
  render(<App />);
  return events;
}

async function notesInArchive(path: string) {
  await invoke("open_document", { windowLabel: "verify", path });
  try {
    const page = await invoke<{ total: number }>("read_table_page", {
      windowLabel: "verify",
      table: "notes",
      offset: 0,
      limit: 10,
      sorts: [],
      filters: [],
    });
    return page.total;
  } catch {
    return null;
  } finally {
    await invoke("close_document", { windowLabel: "verify", force: true });
  }
}

it("autosaves edits to a saved document and shows dirty, saving, and saved states", async () => {
  const user = await renderNewDocument();
  const path = archivePath("autosave");
  dialogMock.save.mockResolvedValueOnce(path);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, LONG);
  const status = screen.getByRole("group", { name: "Save status" });
  expect(status).toHaveTextContent(/Saved at/);

  await createTable("tasks", [{ name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 }]);
  await waitFor(() => expect(status).toHaveTextContent("Unsaved changes"), LONG);
  await waitFor(() => expect(status).toHaveTextContent(/Saved at/), LONG);
  const saved = await state();
  expect(saved.dirty).toBe(false);
  expect(saved.lastSavedAt).toBeTruthy();
  await invoke("open_document", { windowLabel: "verify", path });
  const objects = await invoke<Array<{ name: string }>>("list_database_objects", {
    windowLabel: "verify",
  });
  await invoke("close_document", { windowLabel: "verify", force: true });
  expect(objects.map((object) => object.name)).toContain("tasks");
  const logs = await invoke<Array<{ area: string; message: string }>>("read_logs", {
    windowLabel: "main",
    limit: 50,
  });
  expect(logs.some((line) => line.area === "autosave" && line.message.includes(path))).toBe(true);
});

it("surfaces an autosave failure and retries it on request", async () => {
  const user = await renderNewDocument();
  const path = archivePath("retry");
  dialogMock.save.mockResolvedValueOnce(path);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, LONG);
  const status = screen.getByRole("group", { name: "Save status" });

  renameSync(path, `${path}.moved`);
  await createTable("later", [{ name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 }]);
  await waitFor(() => expect(status).toHaveTextContent("Save failed"), LONG);
  expect((await state()).lastError?.code).toBe("MISSING_FILE");

  renameSync(`${path}.moved`, path);
  await user.click(within(status).getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(status).toHaveTextContent(/Saved at/), LONG);
  expect((await state()).dirty).toBe(false);
});

it("recovers a crashed session's unsaved work into its archive from the start screen", async () => {
  const path = archivePath("crash");
  const crashed = await seedCrashedSession("crashy", "Crash Notes", path);
  expect(await notesInArchive(path)).toBeNull();

  const user = renderStartScreen();
  await screen.findByRole("heading", { name: "Recover unsaved work" }, LONG);
  await user.click(screen.getByRole("button", { name: "Recover Crash Notes" }));
  expect(await screen.findByText("Saved archive", {}, LONG)).toBeInTheDocument();
  const recovered = await state();
  expect(recovered.sessionId).toBe(crashed.sessionId);
  expect(recovered.dirty).toBe(false);
  expect((await readPage("notes")).total).toBe(1);
  expect(await notesInArchive(path)).toBe(1);
  const checkpoints = await invoke<Array<{ reason: string }>>("list_checkpoints", {
    windowLabel: "main",
  });
  expect(checkpoints.map((checkpoint) => checkpoint.reason)).toContain("before-recovery");
  expect(await invoke<unknown[]>("list_recovery_sessions", {})).toEqual([]);
});

it("asks where to save recovered work that was never saved", async () => {
  await seedCrashedSession("untitled", "Draft Ideas", null);
  const destination = archivePath("rescued");
  dialogMock.save.mockResolvedValueOnce(destination);
  const user = renderStartScreen();
  await user.click(await screen.findByRole("button", { name: "Recover Draft Ideas" }, LONG));
  expect(await screen.findByText("Saved archive", {}, LONG)).toBeInTheDocument();
  expect(dialogMock.save).toHaveBeenCalledOnce();
  expect((await state()).path).toBe(destination);
  expect(await notesInArchive(destination)).toBe(1);
});

it("asks for Save As instead of overwriting a saved file it cannot checkpoint", async () => {
  const path = archivePath("unreadable");
  await seedCrashedSession("garbled", "Garbled Notes", path);
  writeFileSync(path, "not an archive any more");
  const before = readFileSync(path);
  const destination = archivePath("garbled-rescued");
  dialogMock.save.mockResolvedValueOnce(destination);

  const user = renderStartScreen();
  await user.click(await screen.findByRole("button", { name: "Recover Garbled Notes" }, LONG));
  expect(await screen.findByText("Saved archive", {}, LONG)).toBeInTheDocument();
  expect(dialogMock.save).toHaveBeenCalledOnce();
  expect(readFileSync(path).equals(before)).toBe(true);
  expect((await state()).path).toBe(destination);
  expect(await notesInArchive(destination)).toBe(1);
});

it("keeps the last valid archive when recovered work is invalid, then discards it", async () => {
  const path = archivePath("invalid");
  const crashed = await seedCrashedSession("broken", "Broken Work", path);
  const before = readFileSync(path);
  writeFileSync(join(crashed.workspace, "document.json"), "{ truncated");

  const user = renderStartScreen();
  await user.click(await screen.findByRole("button", { name: "Recover Broken Work" }, LONG));
  const alert = await screen.findByRole("alert", {}, LONG);
  expect(alert).toHaveTextContent("RECOVERY_FAILED");
  expect(alert).toHaveTextContent("The last saved archive was kept");
  expect(readFileSync(path).equals(before)).toBe(true);

  vi.spyOn(window, "confirm").mockReturnValueOnce(true);
  await user.click(screen.getByRole("button", { name: "Discard Broken Work" }));
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Recover unsaved work" })).not.toBeInTheDocument(),
  );
  expect(existsSync(crashed.workspace)).toBe(false);
});

it("ignores leftovers of an interrupted archive write and cleans them up on the next save", async () => {
  const path = archivePath("interrupted");
  await invoke("new_document", { windowLabel: "seed" });
  await invoke("save_document_as", { windowLabel: "seed", path });
  await invoke("close_document", { windowLabel: "seed", force: true });
  const name = path.split("/").pop();
  const leftover = join(process.env.IXTABLE_STATE_DIR!, `.${name}.crashed.tmp`);
  writeFileSync(leftover, readFileSync(path).subarray(0, 512));

  await invoke("open_document", { windowLabel: "main", path });
  await invoke("save_document", { windowLabel: "main" });
  expect(existsSync(leftover)).toBe(false);
  expect((await state()).lastError).toBeNull();
});
