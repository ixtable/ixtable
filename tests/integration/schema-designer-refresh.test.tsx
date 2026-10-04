import { act, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { announceDatabaseChange, createTable, refreshDatabase, renderNewDocument } from "./helpers";

const gate = vi.hoisted(() => ({ held: false, release: [] as Array<() => void> }));

vi.mock("../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/api")>();
  return {
    ...actual,
    inspectTable: async (...args: Parameters<typeof actual.inspectTable>) => {
      if (gate.held) await new Promise<void>((resolve) => gate.release.push(resolve));
      return actual.inspectTable(...args);
    },
  };
});

const LONG = { timeout: 20_000 };

it("disables the table designer while its schema reloads", async () => {
  const user = await renderNewDocument();
  await createTable("parts", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
  ]);
  await refreshDatabase();
  await user.click(await screen.findByRole("button", { name: /^parts\b/ }, LONG));
  await user.click(await screen.findByRole("button", { name: "Design table" }, LONG));
  await screen.findByRole("heading", { name: "Design parts" }, LONG);
  expect(screen.getByRole("textbox", { name: "New column name" })).toBeEnabled();

  gate.held = true;
  announceDatabaseChange();
  expect(await screen.findByText("Refreshing schema…", {}, LONG)).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "New column name" })).toBeDisabled();

  gate.held = false;
  act(() => {
    for (const release of gate.release.splice(0)) release();
  });
  await waitFor(() => expect(screen.queryByText("Refreshing schema…")).toBeNull(), LONG);
  expect(screen.getByRole("textbox", { name: "New column name" })).toBeEnabled();
});
