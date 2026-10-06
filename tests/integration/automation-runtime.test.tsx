import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { asTauriError } from "../../src/lib/api";
import { insertRecord, updateRecord } from "../../src/lib/records";
import { createTable, insertRow, readPage, renderNewDocument, value } from "./helpers";

const LONG = { timeout: 20_000 };
type User = Awaited<ReturnType<typeof renderNewDocument>>;
const text = (v: string) => value("text", v);

async function setup(user: User, extra: (config: Record<string, unknown>) => object) {
  await createTable("orders", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "status", declaredType: "TEXT" },
  ]);
  await createTable("audit", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "message", declaredType: "TEXT" },
  ]);
  await insertRow("orders", [
    { column: "id", value: value("integer", 1) },
    { column: "status", value: text("open") },
  ]);
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(await screen.findByRole("tab", { name: "Entities" }, LONG));
  await screen.findByRole("combobox", { name: "Concurrency policy for orders" }, LONG);
  const config = await invoke<Record<string, unknown>>("read_document_config", {
    windowLabel: "main",
  });
  await invoke("update_document_config", {
    windowLabel: "main",
    config: { ...config, ...extra(config) },
  });
  await user.click(screen.getByRole("tab", { name: "Datasource" }));
  await user.click(screen.getByRole("tab", { name: "Entities" }));
  await screen.findByRole("heading", { name: "Entities" }, LONG);
}

it("follows navigate and setState steps from a sync trigger in the Runtime", async () => {
  const user = await renderNewDocument();
  await setup(user, () => ({
    actions: [
      {
        id: "go",
        name: "Show audit",
        onError: "stop",
        steps: [
          { id: "s1", kind: "setState", scope: "app", key: "lastOrder", value: "record.id" },
          {
            id: "s2",
            kind: "createRecord",
            table: "audit",
            values: { message: "'order ' & app.lastOrder & ' by ' & app.user.name" },
          },
          { id: "s3", kind: "navigate", target: { kind: "table", id: "audit" } },
        ],
      },
    ],
    triggers: [
      {
        id: "t1",
        name: "Open audit",
        table: "orders",
        event: "created",
        actionId: "go",
        mode: "sync",
        enabled: true,
        maxAttempts: 1,
        backoffMs: 0,
      },
    ],
  }));
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const page = await screen.findByRole("region", { name: "Application page" }, LONG);
  await insertRecord("orders", [{ column: "status", value: text("new") }]);
  await within(page).findByText("order 2 by Developer", {}, LONG);
  await waitFor(
    async () =>
      expect((await readPage("audit")).rows.map((r) => r[1])).toEqual([
        text("order 2 by Developer"),
      ]),
    LONG,
  );
});

it("runs the custom concurrency action instead of writing a customAction entity", async () => {
  const user = await renderNewDocument();
  await setup(user, () => ({
    actions: [
      {
        id: "guard",
        name: "Guard order changes",
        onError: "rollback",
        steps: [
          {
            id: "g1",
            kind: "createRecord",
            table: "audit",
            values: { message: "params.operation & ': ' & old.status & ' → ' & record.status" },
          },
          {
            id: "g2",
            kind: "updateRecord",
            table: "orders",
            match: "current",
            values: { status: "upper(record.status)" },
          },
        ],
      },
    ],
  }));
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Concurrency policy for orders" }),
    "customAction",
  );
  await user.selectOptions(
    await screen.findByRole("combobox", { name: "Action for orders" }, LONG),
    "Guard order changes",
  );
  await waitFor(async () => {
    const saved = await invoke<{ entities: Array<{ table: string; actionId?: string }> }>(
      "read_document_config",
      { windowLabel: "main" },
    );
    expect(saved.entities.find((e) => e.table === "orders")?.actionId).toBe("guard");
  }, LONG);
  await updateRecord("orders", [{ column: "status", value: text("paid") }], [value("integer", 1)], {
    expected: [{ column: "status", value: text("open") }],
  });
  expect((await readPage("orders")).rows[0][1]).toEqual(text("PAID"));
  expect((await readPage("audit")).rows.map((r) => r[1])).toEqual([text("update: open → paid")]);
  const blind = await invoke("update_row", {
    windowLabel: "main",
    table: "orders",
    values: [{ column: "status", value: text("x") }],
    identity: [value("integer", 1)],
  }).catch((reason: unknown) => asTauriError(reason).code);
  expect(blind).toBe("EXPECTED_REQUIRED");
});
