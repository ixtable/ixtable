import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { renderNewDocument } from "./helpers";

const LONG = { timeout: 20_000 };
const writes = vi.hoisted(() => ({ hold: false, release: () => {} }));

vi.mock("../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/api")>();
  return {
    ...actual,
    updateDocumentConfig: async (...args: Parameters<typeof actual.updateDocumentConfig>) => {
      if (writes.hold) await new Promise<void>((resolve) => (writes.release = resolve));
      return actual.updateDocumentConfig(...args);
    },
  };
});

it("keeps an editor the user opened while the previous save was still being written", async () => {
  const user = await renderNewDocument();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: "Migrations" }));
  await user.click(await screen.findByRole("button", { name: "New migration" }, LONG));
  const editor = await screen.findByRole("region", { name: /Edit migration/ }, LONG);
  const nameBox = within(editor).getByRole("textbox", { name: "Name" });
  await user.clear(nameBox);
  await user.type(nameBox, "Quick");
  await user.click(within(editor).getByRole("textbox", { name: "Up SQL" }));
  await user.paste("CREATE TABLE quick (id INTEGER);");

  writes.hold = true;
  await user.click(within(editor).getByRole("button", { name: "Save migration" }));
  await user.click(await screen.findByRole("button", { name: "Edit Quick" }, LONG));
  writes.hold = false;
  writes.release();

  await waitFor(async () => {
    const config = await invoke<{ migrations: unknown[] }>("read_document_config", {
      windowLabel: "main",
    });
    expect(config.migrations).toHaveLength(1);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(screen.getByRole("region", { name: "Edit migration Quick" })).toBeInTheDocument();
});
