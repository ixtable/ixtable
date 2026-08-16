import { screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { renderNewDocument } from "./helpers";

it("creates a real isolated session, requires Save As, and confirms dirty close", async () => {
  const user = await renderNewDocument();
  const state = await invoke<{ workspace: string; dirty: boolean }>("document_state", {
    windowLabel: "main",
  });
  expect(state.workspace).toContain("ixtable-integration-");
  expect(state.dirty).toBe(false);

  await user.click(screen.getByRole("button", { name: "Save project" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("SAVE_AS_REQUIRED");

  await user.click(screen.getByRole("button", { name: "Design" }));
  await screen.findByText("Form builder");

  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  expect(screen.getByText("Form builder")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close project" }));
  expect(
    await screen.findByRole("heading", { name: "Your data, in one portable file." }),
  ).toBeInTheDocument();
  expect(confirm).toHaveBeenCalledTimes(2);
});
