import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { runAction } from "../../src/automation/runner";
import type { DocumentConfig } from "../../src/lib/types";
import { createTable, insertRow, readPage, renderNewDocument, value } from "./helpers";

const LONG = { timeout: 20_000 };
type User = Awaited<ReturnType<typeof renderNewDocument>>;
const text = (v: string) => value("text", v);

async function orders() {
  await createTable("orders", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "status", declaredType: "TEXT" },
    { name: "note", declaredType: "TEXT" },
  ]);
  await insertRow("orders", [
    { column: "id", value: value("integer", 1) },
    { column: "status", value: text("open") },
    { column: "note", value: text("n") },
  ]);
}

async function configure(extra: object) {
  const config = await invoke<Record<string, unknown>>("read_document_config", {
    windowLabel: "main",
  });
  await invoke("update_document_config", { windowLabel: "main", config: { ...config, ...extra } });
  return invoke<DocumentConfig>("read_document_config", { windowLabel: "main" });
}

const failing = (event: string) => ({
  actions: [
    {
      id: "boom",
      name: "Boom",
      onError: "stop",
      steps: [{ id: "f1", kind: "fail", message: "'audit is down'" }],
    },
  ],
  triggers: [
    {
      id: "t1",
      name: "Audit",
      table: "orders",
      event,
      actionId: "boom",
      mode: "sync",
      enabled: true,
      maxAttempts: 1,
      backoffMs: 0,
    },
  ],
});

async function generateForm(user: User, extra: object) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(await screen.findByRole("tab", { name: "Entities" }, LONG));
  await screen.findByRole("combobox", { name: "Concurrency policy for orders" }, LONG);
  await configure(extra);
  await user.click(screen.getByRole("tab", { name: "Datasource" }));
  await user.click(screen.getByRole("tab", { name: "Entities" }));
  await screen.findByRole("heading", { name: "Entities" }, LONG);
  await user.click(screen.getByRole("button", { name: "Design" }));
  await screen.findByRole("region", { name: "Form builder" }, LONG);
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Table to generate from" }),
    "orders",
  );
  await user.click(screen.getByRole("button", { name: "Generate form from table" }));
  const forms = screen.getByRole("region", { name: "Forms" });
  await within(forms).findByRole("button", { name: "Orders list" }, LONG);
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const page = await screen.findByRole("region", { name: "Application page" }, LONG);
  const nav = screen.getByRole("navigation", { name: "Application navigation" });
  await user.click(within(nav).getByRole("button", { name: "Orders" }));
  return page;
}

it("updates the same row twice and updates then deletes it in one rollback action", async () => {
  await renderNewDocument();
  await orders();
  await insertRow("orders", [
    { column: "id", value: value("integer", 2) },
    { column: "status", value: text("open") },
    { column: "note", value: text("n") },
  ]);
  const config = await configure({});
  const ctx = {
    config,
    app: {},
    navigate: () => undefined,
    setState: () => undefined,
    confirm: async () => true,
    notify: () => undefined,
  };
  const twice = await runAction(
    {
      id: "a1",
      name: "Approve",
      onError: "rollback",
      steps: [
        {
          id: "s1",
          kind: "updateRecord",
          table: "orders",
          match: "current",
          values: { status: "'approved'" },
        },
        {
          id: "s2",
          kind: "updateRecord",
          table: "orders",
          match: "current",
          values: { note: "'done'" },
        },
      ],
    },
    { ...ctx, record: { id: 1 } },
  );
  expect(twice).toMatchObject({ ok: true });
  const purge = await runAction(
    {
      id: "a2",
      name: "Purge",
      onError: "rollback",
      steps: [
        {
          id: "s1",
          kind: "updateRecord",
          table: "orders",
          match: "current",
          values: { status: "'gone'" },
        },
        { id: "s2", kind: "deleteRecord", table: "orders", match: "current" },
      ],
    },
    { ...ctx, record: { id: 2 } },
  );
  expect(purge).toMatchObject({ ok: true });
  const rows = (await readPage("orders")).rows;
  expect(rows).toEqual([[value("integer", 1), text("approved"), text("done")]]);
});

it("opens a created record as saved when a sync trigger fails after the insert", async () => {
  const user = await renderNewDocument();
  await orders();
  const page = await generateForm(user, failing("created"));
  await user.click(await within(page).findByRole("button", { name: "New orders" }, LONG));
  const create = await screen.findByRole("form", { name: "New Orders" }, LONG);
  await user.type(within(create).getByRole("textbox", { name: "Status" }), "fresh");
  await user.click(within(create).getByRole("button", { name: "Create" }));
  await screen.findByText(/Saved\. .*audit is down/, {}, LONG);
  const detail = await screen.findByRole("form", { name: "Orders" }, LONG);
  expect(within(detail).queryByRole("button", { name: "Create" })).toBeNull();
  await waitFor(async () => expect((await readPage("orders")).rows).toHaveLength(2), LONG);
});

it("reloads an updated record when a sync trigger fails after the update", async () => {
  const user = await renderNewDocument();
  await orders();
  const page = await generateForm(user, failing("updated"));
  await user.click(await within(page).findByRole("row", { name: /Open/ }, LONG));
  const detail = await screen.findByRole("form", { name: "Orders" }, LONG);
  await within(detail).findByDisplayValue("open", {}, LONG);
  await user.click(within(detail).getByRole("button", { name: "Edit" }));
  const edit = await screen.findByRole("form", { name: "Edit Orders" }, LONG);
  await within(edit).findByDisplayValue("open", {}, LONG);
  await user.clear(within(edit).getByRole("textbox", { name: "Status" }));
  await user.type(within(edit).getByRole("textbox", { name: "Status" }), "paid");
  await user.click(within(edit).getByRole("button", { name: "Save" }));
  await screen.findByText(/Saved\. .*audit is down/, {}, LONG);
  const shown = await screen.findByRole("form", { name: "Orders" }, LONG);
  await within(shown).findByDisplayValue("paid", {}, LONG);
  await user.click(within(shown).getByRole("button", { name: "Edit" }));
  const again = await screen.findByRole("form", { name: "Edit Orders" }, LONG);
  await within(again).findByDisplayValue("paid", {}, LONG);
  await user.clear(within(again).getByRole("textbox", { name: "Note" }));
  await user.type(within(again).getByRole("textbox", { name: "Note" }), "second");
  await user.click(within(again).getByRole("button", { name: "Save" }));
  await waitFor(
    async () => expect((await readPage("orders")).rows[0][2]).toEqual(text("second")),
    LONG,
  );
  expect(screen.queryByText(/CONFLICT|changed since/i)).toBeNull();
});
