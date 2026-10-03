import { screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { createTable, insertRow, readPage, renderNewDocument, value } from "./helpers";

const LONG = { timeout: 20_000 };

it("rejects a grid edit made from stale values and shows the current ones", async () => {
  const user = await renderNewDocument();
  await createTable("tickets", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "status", declaredType: "TEXT" },
  ]);
  await insertRow("tickets", [
    { column: "id", value: value("integer", 1) },
    { column: "status", value: value("text", "open") },
  ]);
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  const cell = await screen.findByRole("textbox", { name: "status, row 1" }, LONG);
  await waitFor(() => expect(cell).toHaveValue("open"), LONG);

  await invoke("update_row", {
    windowLabel: "main",
    table: "tickets",
    values: [{ column: "status", value: value("text", "closed") }],
    identity: [value("integer", 1)],
  });

  await user.clear(cell);
  await user.type(cell, "in progress{Enter}");
  expect(await screen.findByRole("alert", {}, LONG)).toHaveTextContent(
    "changed by someone else since you opened it: status is now 'closed'",
  );
  expect((await readPage("tickets")).rows[0][1]).toEqual(value("text", "closed"));
  await waitFor(
    () => expect(screen.getByRole("textbox", { name: "status, row 1" })).toHaveValue("closed"),
    LONG,
  );

  await user.clear(screen.getByRole("textbox", { name: "status, row 1" }));
  await user.type(screen.getByRole("textbox", { name: "status, row 1" }), "done{Enter}");
  await waitFor(
    async () => expect((await readPage("tickets")).rows[0][1]).toEqual(value("text", "done")),
    LONG,
  );
});
