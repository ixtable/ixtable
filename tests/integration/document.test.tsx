import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import App from "../../src/App";
import { renderNewDocument } from "./helpers";
import { dialogMock } from "./setup";

it("applies YAML document config and keeps it valid", async () => {
  await renderNewDocument();
  await invoke("apply_document_config_yaml", {
    windowLabel: "main",
    yaml: "name: YAML App\nactiveMode: design\nversion: 2\n",
  });
  const config = await invoke<{ name: string; activeMode: string; design: { version: number } }>(
    "read_document_config",
    { windowLabel: "main" },
  );
  expect(config.name).toBe("YAML App");
  expect(config.activeMode).toBe("design");
  expect(config.design.version).toBe(3);
  const yaml = await invoke<string>("read_document_config_yaml", { windowLabel: "main" });
  expect(yaml).toContain("YAML App");
});

it("creates a document, chooses its first destination, and saves existing documents in place", async () => {
  const user = await renderNewDocument();
  const destination = join(process.env.IXTABLE_STATE_DIR!, "created.ixt");
  dialogMock.save.mockResolvedValueOnce(destination);

  await user.click(screen.getByRole("button", { name: "Save project" }));
  expect(await screen.findByText("Saved archive", {}, { timeout: 20_000 })).toBeInTheDocument();
  expect(dialogMock.save).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", { name: "Save project" }));
  expect(dialogMock.save).toHaveBeenCalledOnce();
});

it("opens an ixt archive and reports an invalid archive error", async () => {
  const archive = join(process.env.IXTABLE_STATE_DIR!, "open.ixt");
  await invoke("new_document", { windowLabel: "seed" });
  await invoke("save_document_as", { windowLabel: "seed", path: archive });
  await invoke("close_document", { windowLabel: "seed", force: true });
  const user = userEvent.setup();
  render(<App />);
  dialogMock.open.mockResolvedValueOnce(archive);

  await user.click(screen.getByRole("button", { name: /Open document/i }));
  expect(await screen.findByText("Saved archive", {}, { timeout: 20_000 })).toBeInTheDocument();

  const invalid = join(process.env.IXTABLE_STATE_DIR!, "invalid.ixt");
  writeFileSync(invalid, "not an ixtable archive");
  dialogMock.open.mockResolvedValueOnce(invalid);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  await user.click(
    await screen.findByRole("button", { name: /Open document/i }, { timeout: 20_000 }),
  );
  expect(await screen.findByRole("alert", {}, { timeout: 20_000 })).toHaveTextContent(
    "INVALID_ARCHIVE",
  );
});

it("offers Save As for an existing document", async () => {
  const user = await renderNewDocument();
  const first = join(process.env.IXTABLE_STATE_DIR!, "first.ixt");
  const second = join(process.env.IXTABLE_STATE_DIR!, "second.ixt");
  dialogMock.save.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, { timeout: 20_000 });

  await user.click(screen.getByRole("button", { name: "Save project as" }));
  await waitFor(async () => {
    const state = await invoke<{ path: string }>("document_state", { windowLabel: "main" });
    expect(state.path).toBe(second);
  });
});

it("surfaces picker cancellation without presenting an error", async () => {
  const user = userEvent.setup();
  render(<App />);
  dialogMock.open.mockResolvedValueOnce(null);
  await user.click(screen.getByRole("button", { name: /Open document/i }));
  expect(await screen.findByText("Open canceled.", {}, { timeout: 20_000 })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /New document/i }));
  await screen.findByText("Relationship Browser", {}, { timeout: 20_000 });
  dialogMock.save.mockResolvedValueOnce(null);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  expect(await screen.findByText("Save canceled.", {}, { timeout: 20_000 })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("confirms before closing a dirty new document", async () => {
  const user = await renderNewDocument();
  await user.click(screen.getByRole("button", { name: "Design" }));
  await screen.findByText("Form builder", {}, { timeout: 20_000 });
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  expect(screen.getByText("Form builder")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close project" }));
  expect(
    await screen.findByRole(
      "heading",
      { name: "Your data, in one portable file." },
      { timeout: 20_000 },
    ),
  ).toBeInTheDocument();
  expect(confirm).toHaveBeenCalledTimes(2);
});
