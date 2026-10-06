import { fireEvent, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LONG, openPage, runtimePage, startFromTemplate } from "./golden/journey";

const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null }));

vi.mock("@tauri-apps/api/core", async () => {
  const { testBridge } = await import("./setup");
  return {
    invoke: async (command: string, args?: Record<string, unknown>) => {
      if (command === "inspect_table" && gate.hold) await gate.hold;
      return testBridge.invoke(command, args);
    },
  };
});

it("opens the clicked record when its table schema is still loading after a database change", async () => {
  const user = await startFromTemplate("Work orders");
  const page = runtimePage();
  await openPage(user, "Work orders");
  await user.click(await within(page).findByRole("row", { name: "Open WO-1001" }, LONG));
  await within(page).findByRole("form", { name: "Work order" }, LONG);

  let release = () => {};
  gate.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  fireEvent(window, new Event("ixtable:database-changed"));
  await user.click(within(page).getByRole("button", { name: "Back to Work orders" }));
  await user.click(await within(page).findByRole("row", { name: "Open WO-1002" }, LONG));
  gate.hold = null;
  release();

  const form = await within(page).findByRole("form", { name: "Work order" }, LONG);
  expect(within(form).queryByText("This record no longer exists.")).toBeNull();
  expect(await within(form).findByDisplayValue("WO-1002", {}, LONG)).toBeInTheDocument();
  await user.click(await within(form).findByRole("button", { name: "Start work" }, LONG));
  await within(form).findByText("Work order started.", {}, LONG);
}, 120_000);
