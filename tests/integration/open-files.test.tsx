import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import App from "../../src/App";
import { OPEN_FILES_EVENT } from "../../src/lib/launch";
import type { DocumentConfig } from "../../src/lib/types";
import { renderNewDocument } from "./helpers";
import { emitTauriEvent } from "./setup";

const LONG = { timeout: 20_000 };
const statePath = (name: string) => join(process.env.IXTABLE_STATE_DIR!, name);
const windowLabel = "main";

async function seedDocument(name: string, bundle?: string) {
  await invoke("new_document", { windowLabel });
  const config = await invoke<DocumentConfig>("read_document_config", { windowLabel });
  await invoke("update_document_config", { windowLabel, config: { ...config, name } });
  const path = statePath(`${name.replace(/\W/g, "-")}.ixt`);
  await invoke("save_document_as", { windowLabel, path });
  if (bundle) {
    await invoke("export_runtime_bundle", {
      windowLabel,
      path: bundle,
      options: { version: "1.0.0", releaseNotes: "" },
    });
  }
  await invoke("close_document", { windowLabel, force: true });
  return path;
}

const documentLabel = () => screen.findByText("PROJECT", {}, LONG);

it("opens a forwarded document from the start screen", async () => {
  const path = await seedDocument("Launch one");
  render(<App />);
  await screen.findByRole("button", { name: /New document/ }, LONG);
  emitTauriEvent(OPEN_FILES_EVENT, [path]);
  await documentLabel();
  expect(await screen.findByText("Launch one", {}, LONG)).toBeInTheDocument();
}, 60_000);

it("asks before a forwarded document replaces unsaved work", async () => {
  const path = await seedDocument("Launch two");
  const user = await renderNewDocument();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  emitTauriEvent(OPEN_FILES_EVENT, [path]);
  await waitFor(() =>
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Launch-two\.ixt/)),
  );
  expect(await screen.findByText(/Kept Untitled open/, {}, LONG)).toBeInTheDocument();
  expect(screen.queryByText("Launch two")).not.toBeInTheDocument();

  confirm.mockReturnValue(true);
  emitTauriEvent(OPEN_FILES_EVENT, [path]);
  expect(await screen.findByText("Launch two", {}, LONG)).toBeInTheDocument();
}, 60_000);

it("routes a forwarded runtime bundle to the bundle open flow", async () => {
  const bundle = statePath("forwarded-1.0.0.ixtr");
  const document = await seedDocument("Bundled app", bundle);
  render(<App />);
  await screen.findByRole("button", { name: /New document/ }, LONG);
  emitTauriEvent(OPEN_FILES_EVENT, [document]);
  await documentLabel();

  const confirm = vi.spyOn(window, "confirm");
  emitTauriEvent(OPEN_FILES_EVENT, [bundle]);
  const runtime = await screen.findByRole("region", { name: "Runtime bundle" }, LONG);
  expect(within(runtime).getByText("Version 1.0.0")).toBeInTheDocument();
  expect(confirm).not.toHaveBeenCalled();
}, 60_000);
