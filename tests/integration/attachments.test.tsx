import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { renderNewDocument } from "./helpers";

const files: string[] = [];
afterEach(() => {
  for (const directory of files.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("imports, lists, exports, deletes, saves, and reopens attachments", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ixtable-attachments-"));
  files.push(directory);
  const source = join(directory, "project notes.txt");
  const exported = join(directory, "exported notes.txt");
  const archive = join(directory, "attachments.ixt");
  writeFileSync(source, "portable attachment");
  vi.mocked(open).mockResolvedValueOnce(source).mockResolvedValueOnce(source);
  vi.mocked(save).mockResolvedValueOnce(exported);

  const user = await renderNewDocument();
  await user.click(screen.getByRole("button", { name: "Import attachment" }));
  expect(await screen.findByText("project notes.txt")).toBeInTheDocument();
  expect(screen.getByText("text/plain")).toBeInTheDocument();
  expect(screen.getByText("19 B")).toBeInTheDocument();
  expect(screen.getByText(/^Added /)).toBeInTheDocument();
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  expect(screen.getByText("ATTACHMENTS").nextSibling).toHaveTextContent("1");

  await user.click(screen.getByRole("button", { name: "Export project notes.txt" }));
  await waitFor(() => expect(existsSync(exported)).toBe(true));
  expect(readFileSync(exported, "utf8")).toBe("portable attachment");

  vi.spyOn(window, "confirm").mockReturnValueOnce(true);
  await user.click(screen.getByRole("button", { name: "Remove project notes.txt" }));
  await waitFor(() => expect(screen.getByText("No attachments")).toBeInTheDocument());
  expect(screen.getByText("ATTACHMENTS").nextSibling).toHaveTextContent("0");
  await user.click(screen.getByRole("button", { name: "Import attachment" }));
  expect(await screen.findByText("project notes.txt")).toBeInTheDocument();

  await invoke("save_document_as", { windowLabel: "main", path: archive });
  await user.click(screen.getByRole("button", { name: "Save project" }));
  expect(await screen.findByText("All changes saved")).toBeInTheDocument();
  await invoke("close_document", { windowLabel: "main", force: false });
  cleanup();
  const reopened = await invoke<{ attachmentCount: number; dirty: boolean }>("open_document", {
    windowLabel: "main",
    path: archive,
  });
  expect(reopened).toMatchObject({ attachmentCount: 1, dirty: false });
  expect(await invoke("list_attachments", { windowLabel: "main" })).toEqual([
    expect.objectContaining({
      displayName: "project notes.txt",
      mediaType: "text/plain",
      size: 19,
    }),
  ]);
});

it("handles duplicate names, unknown types, and picker cancellation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ixtable-attachments-edge-"));
  files.push(directory);
  const source = join(directory, "payload.mystery");
  writeFileSync(source, "one");
  vi.mocked(open)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(source)
    .mockResolvedValueOnce(source);
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false);

  const user = await renderNewDocument();
  await user.click(screen.getByRole("button", { name: "Import attachment" }));
  expect(screen.getByText("No attachments")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Import attachment" }));
  expect(await screen.findByText("application/octet-stream")).toBeInTheDocument();
  expect(screen.getByText(/unknown file type/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Import attachment" }));
  expect(confirm).toHaveBeenCalledWith("payload.mystery is already attached. Import another copy?");
  expect(screen.getByText("ATTACHMENTS").nextSibling).toHaveTextContent("1");
});
