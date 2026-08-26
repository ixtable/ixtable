import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import App, { type DocumentConfig } from "../../src/App";

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
});
afterEach(async () => {
  await invoke("close_document", { windowLabel: "main", force: true }).catch(() => undefined);
});

it("renders empty, populated, expanded, and stale recent-file states", async () => {
  render(<App />);
  expect(await screen.findByText("No recent documents")).toBeInTheDocument();

  for (let index = 0; index < 6; index++) {
    await invoke("new_document", { windowLabel: "main" });
    await invoke("save_document_as", { windowLabel: "main", path: `/tmp/recent-${index}.ixt` });
    await invoke("close_document", { windowLabel: "main", force: true });
  }
  const { unmount } = render(<App />);
  expect(await screen.findByText("recent-5.ixt")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "View all" }));
  expect(await screen.findByText("recent-0.ixt")).toBeInTheDocument();
  await invoke("open_document", { windowLabel: "main", path: "/tmp/recent-5.ixt" });
  await invoke("close_document", { windowLabel: "main", force: true });
  await import("node:fs").then(({ unlinkSync }) => unlinkSync("/tmp/recent-5.ixt"));
  await user.click(screen.getByRole("button", { name: /recent-5\.ixt/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("MISSING_FILE");
  unmount();
});

it("offers document details and working recover and discard actions", async () => {
  await invoke("new_document", { windowLabel: "main" });
  const config = await invoke<DocumentConfig>("read_document_config", { windowLabel: "main" });
  await invoke("update_document_config", {
    windowLabel: "main",
    config: { ...config, name: "Recovered inventory", activeMode: "design" },
  });
  render(<App />);
  const recovery = await screen.findByText(/Document [\da-f]{8}/);
  const card = recovery.closest("article")!;
  expect(within(card).getByText(/Last updated/)).toBeInTheDocument();
  await user.click(within(card).getByRole("button", { name: "Recover" }));
  expect(await screen.findByText("Recovered inventory")).toBeInTheDocument();
  await invoke("close_document", { windowLabel: "main", force: true });

  await invoke("new_document", { windowLabel: "main" });
  const { unmount } = render(<App />);
  const discard = await screen.findByRole("button", { name: "Discard" });
  await user.click(discard);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Discard" })).not.toBeInTheDocument(),
  );
  unmount();
});
