import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { renderNewDocument } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };
type User = Awaited<ReturnType<typeof renderNewDocument>>;

function fixture(name: string, contents: string | Buffer) {
  const dir = mkdtempSync(join(process.env.IXTABLE_STATE_DIR!, "assets-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

async function openSettingsTab(user: User, tab: string) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: tab }));
}

async function importFile(user: User, path: string) {
  dialogMock.open.mockResolvedValueOnce(path);
  await user.click(screen.getByRole("button", { name: "Import asset" }));
}

it("imports, deduplicates, exports, and removes application assets", async () => {
  const user = await renderNewDocument();
  await openSettingsTab(user, "Assets");
  const logo = fixture("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  await importFile(user, logo);
  const table = await screen.findByRole("table", { name: "Assets" }, LONG);
  const row = within(table).getByRole("row", { name: /logo\.png/ });
  expect(row).toHaveTextContent("image/png");
  expect(row).toHaveTextContent("7 B");
  expect(await screen.findByText("Imported logo.png.", {}, LONG)).toBeInTheDocument();

  await importFile(
    user,
    fixture("copy-of-logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
  );
  expect(
    await screen.findByText("Same content as logo.png; reused the existing asset.", {}, LONG),
  ).toBeInTheDocument();
  expect(within(table).getAllByRole("row")).toHaveLength(2);
  const state = await invoke<{ attachmentCount: number; dirty: boolean }>("document_state", {
    windowLabel: "main",
  });
  expect(state).toMatchObject({ attachmentCount: 1, dirty: true });

  const destination = join(process.env.IXTABLE_STATE_DIR!, "exported-logo.png");
  dialogMock.save.mockResolvedValueOnce(destination);
  await user.click(within(table).getByRole("button", { name: "Export logo.png" }));
  expect(await screen.findByText("Exported logo.png.", {}, LONG)).toBeInTheDocument();
  expect(readFileSync(destination)).toEqual(readFileSync(logo));

  vi.spyOn(window, "confirm").mockReturnValueOnce(true);
  await user.click(within(table).getByRole("button", { name: "Remove logo.png" }));
  expect(await screen.findByText("Removed logo.png.", {}, LONG)).toBeInTheDocument();
  await waitFor(
    () => expect(screen.queryByRole("table", { name: "Assets" })).not.toBeInTheDocument(),
    LONG,
  );
});

it("stores assets in the archive with safe names and finds unused ones", async () => {
  const user = await renderNewDocument();
  await openSettingsTab(user, "Assets");
  await importFile(user, fixture("CON.txt", "reserved device name"));
  await importFile(user, fixture("used.csv", "a,b\n1,2\n"));
  const table = await screen.findByRole("table", { name: "Assets" }, LONG);
  await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(3), LONG);
  expect(within(table).getByRole("row", { name: /_CON\.txt/ })).toHaveTextContent("text/plain");

  const assets = await invoke<Array<{ id: string; displayName: string }>>("list_attachments", {
    windowLabel: "main",
  });
  const used = assets.find((asset) => asset.displayName === "used.csv")!;
  const config = await invoke<Record<string, unknown>>("read_document_config", {
    windowLabel: "main",
  });
  await invoke("update_document_config", {
    windowLabel: "main",
    config: { ...config, settings: { importTemplate: used.id } },
  });
  await user.click(screen.getByRole("tab", { name: "Logs" }));
  await user.click(screen.getByRole("tab", { name: "Assets" }));
  const unused = await screen.findByRole("region", { name: "Unused assets" }, LONG);
  await waitFor(() => expect(unused).toHaveTextContent("_CON.txt"), LONG);
  expect(unused).not.toHaveTextContent("used.csv");
  await user.click(within(unused).getByRole("button", { name: "Remove unused assets" }));
  expect(await screen.findByText("Removed 1 unused asset.", {}, LONG)).toBeInTheDocument();
  expect(
    await within(unused).findByText("Every asset is referenced by the application."),
  ).toBeInTheDocument();

  const path = join(process.env.IXTABLE_STATE_DIR!, "with-assets.ixt");
  await invoke("save_document_as", { windowLabel: "main", path });
  await invoke("open_document", { windowLabel: "reopen", path });
  const reopened = await invoke<Array<{ displayName: string; checksum: string }>>(
    "list_attachments",
    { windowLabel: "reopen" },
  );
  await invoke("close_document", { windowLabel: "reopen", force: true });
  expect(reopened.map((asset) => asset.displayName)).toEqual(["used.csv"]);
  expect(reopened[0].checksum).toHaveLength(64);
});

it("reports archive size by section against the cloud limit", async () => {
  const user = await renderNewDocument();
  await openSettingsTab(user, "Assets");
  await importFile(user, fixture("photo.bin", Buffer.alloc(200_000, 7)));
  const size = await screen.findByRole("region", { name: "Archive size" }, LONG);
  const largest = await within(size).findByRole("list", { name: "Largest archive entries" }, LONG);
  await waitFor(() => expect(largest).toHaveTextContent("photo.bin"), LONG);
  expect(size).toHaveTextContent("Within the 500 MB cloud limit.");
  expect(size).toHaveTextContent("Measured on a snapshot that includes unsaved changes.");
  for (const section of ["Records", "Configuration", "Assets", "Other"])
    expect(within(size).getByText(section)).toBeInTheDocument();
});

it("creates a checkpoint and restores it as a separate copy", async () => {
  const user = await renderNewDocument();
  await openSettingsTab(user, "Assets");
  const checkpoints = await screen.findByRole("region", { name: "Checkpoints" }, LONG);
  await user.click(within(checkpoints).getByRole("button", { name: "Create checkpoint" }));
  expect(await within(checkpoints).findByText("Checkpoint created.", {}, LONG)).toBeInTheDocument();
  const list = within(checkpoints).getByRole("list", { name: "Checkpoints" });
  expect(list).toHaveTextContent("manual");

  const copy = join(process.env.IXTABLE_STATE_DIR!, "restored-copy.ixt");
  dialogMock.save.mockResolvedValueOnce(copy);
  await user.click(
    within(list).getByRole("button", { name: /^Restore checkpoint from .* as a copy$/ }),
  );
  expect(await within(checkpoints).findByText(/Restored a copy to/, {}, LONG)).toBeInTheDocument();
  const current = await invoke<{ documentId: string }>("document_state", { windowLabel: "main" });
  const restored = await invoke<{ documentId: string }>("open_document", {
    windowLabel: "copy",
    path: copy,
  });
  await invoke("close_document", { windowLabel: "copy", force: true });
  expect(restored.documentId).not.toBe(current.documentId);
});

it("shows redacted diagnostic logs and copies them", async () => {
  const user = await renderNewDocument();
  await invoke("write_log", {
    windowLabel: "main",
    level: "warn",
    area: "test",
    message: "connect postgres://admin:hunter2@db/app password=hunter2",
  });
  await openSettingsTab(user, "Logs");
  const lines = await screen.findByRole("list", { name: "Log entries" }, LONG);
  expect(lines).toHaveTextContent("postgres://admin:***@db/app password=***");
  expect(lines).not.toHaveTextContent("hunter2");
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByText(/^Copied \d+ log lines\.$/, {}, LONG)).toBeInTheDocument();
  expect(await navigator.clipboard.readText()).toContain("ui:test");
});
