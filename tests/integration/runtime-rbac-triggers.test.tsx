import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { browserContext } from "../../src/automation/context";
import { installCustomActions } from "../../src/automation/custom";
import { installTriggers, type TriggerEnv } from "../../src/automation/triggers";
import { asTauriError } from "../../src/lib/api";
import { insertRecord, updateRecord } from "../../src/lib/records";
import type { DocumentConfig } from "../../src/lib/types";
import { setPreviewedRole } from "../../src/runtime/rbac";
import { value } from "./helpers";

const W = "main";
let config: DocumentConfig;
let uninstall: () => void = () => undefined;
const env: TriggerEnv = {
  getConfig: () => config,
  context: (base) => browserContext(config, () => undefined, base),
};

const table = (name: string, columns: string[]) =>
  invoke("create_database_table", {
    windowLabel: W,
    spec: {
      name,
      columns: columns.map((column, i) => ({
        name: column,
        declaredType: i === 0 ? "INTEGER" : "TEXT",
        nullable: true,
        primaryKeyPosition: i === 0 ? 1 : 0,
        unique: false,
        defaultExpression: null,
        generatedExpression: null,
      })),
      foreignKeys: [],
      checks: [],
      withoutRowid: false,
    },
  });
const rows = async (name: string) => {
  await invoke("set_runtime_role_preview", { windowLabel: W, roleId: null });
  const page = await invoke<{ rows: { value?: unknown }[][] }>("read_table_page", {
    windowLabel: W,
    table: name,
    offset: 0,
    limit: 100,
    sorts: [],
    filters: [],
  });
  await invoke("set_runtime_role_preview", { windowLabel: W, roleId: "clerk" });
  return page.rows.map((r) => r.map((v) => v.value ?? null));
};
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: unknown) => asTauriError(error).code,
  );
const text = (column: string, raw: string) => ({ column, value: value("text", raw) });

beforeEach(async () => {
  await invoke("new_document", { windowLabel: W });
  await table("orders", ["id", "status"]);
  await table("inventory", ["id", "qty"]);
  await table("audit_log", ["id", "message"]);
  await invoke("insert_row", { windowLabel: W, table: "inventory", values: [text("qty", "10")] });
  const current = await invoke<DocumentConfig>("read_document_config", { windowLabel: W });
  config = {
    ...current,
    actions: [
      {
        id: "a-stock",
        name: "Reserve stock",
        onError: "stop",
        steps: [
          {
            id: "s-stock",
            kind: "updateRecord",
            table: "inventory",
            match: { id: "1" },
            values: { qty: "'9'" },
          },
          { id: "s-log", kind: "createRecord", table: "audit_log", values: { message: "'ok'" } },
        ],
      },
    ],
    triggers: [
      {
        id: "t-stock",
        name: "Stock on order",
        table: "orders",
        event: "created",
        actionId: "a-stock",
        mode: "sync",
        enabled: true,
        maxAttempts: 3,
        backoffMs: 1000,
      },
      {
        id: "t-user",
        name: "Stock on change",
        table: "orders",
        event: "updated",
        actionId: "a-stock",
        mode: "sync",
        enabled: true,
        maxAttempts: 3,
        backoffMs: 1000,
        runAs: "user",
      },
    ],
    roles: [
      {
        id: "clerk",
        name: "Clerk",
        permissions: {
          navigation: [],
          actions: [],
          objects: [
            { kind: "table", id: "orders", read: true, create: true, update: true, delete: false },
          ],
        },
      },
    ],
  } as DocumentConfig;
  await invoke("update_document_config", { windowLabel: W, config });
  await invoke("set_runtime_role_preview", { windowLabel: W, roleId: "clerk" });
  setPreviewedRole("clerk");
  uninstall = installTriggers(env);
});

afterEach(async () => {
  uninstall();
  setPreviewedRole(null);
  await invoke("close_document", { windowLabel: W, force: true }).catch(() => undefined);
});

it("app-mode triggers write tables the role cannot, and forged trigger writes are refused", async () => {
  expect(
    await codeOf(
      invoke("insert_row", { windowLabel: W, table: "audit_log", values: [text("message", "x")] }),
    ),
  ).toBe("FORBIDDEN");
  await insertRecord("orders", [text("status", "new")]);
  expect(await rows("inventory")).toEqual([[1, "9"]]);
  expect(await rows("audit_log")).toEqual([[1, "ok"]]);
  const forged = (trigger: Record<string, unknown>) =>
    codeOf(
      invoke("insert_row", {
        windowLabel: W,
        table: "audit_log",
        values: [text("message", "forged")],
        trigger,
      }),
    );
  expect(await forged({ triggerId: "t-stock", stepId: "s-log", grant: "made-up" })).toBe(
    "FORBIDDEN",
  );
  const issued = await invoke<{ triggerGrant?: string }>("insert_row", {
    windowLabel: W,
    table: "orders",
    values: [text("status", "manual")],
  });
  expect(issued.triggerGrant).toBeTruthy();
  expect(
    await forged({ triggerId: "t-stock", stepId: "s-stock", grant: issued.triggerGrant }),
  ).toBe("FORBIDDEN");
  expect(await forged({ triggerId: "t-user", stepId: "s-log", grant: issued.triggerGrant })).toBe(
    "FORBIDDEN",
  );
  expect(await forged({ triggerId: "t-stock", stepId: "s-log", grant: issued.triggerGrant })).toBe(
    "OK",
  );
  await invoke("release_trigger_grant", { windowLabel: W, grant: issued.triggerGrant });
  expect(await forged({ triggerId: "t-stock", stepId: "s-log", grant: issued.triggerGrant })).toBe(
    "FORBIDDEN",
  );
});

it("user-mode triggers refuse the initiating save up front", async () => {
  await insertRecord("orders", [text("status", "new")]);
  const before = await rows("orders");
  const error = await updateRecord("orders", [text("status", "changed")], [value("integer", 1)], {
    expected: [text("status", "new")],
  }).then(
    () => null,
    (e: unknown) => asTauriError(e),
  );
  expect(error?.code).toBe("FORBIDDEN");
  expect(error?.message).toContain("Stock on change");
  expect(error?.message).toContain("inventory");
  expect(await rows("orders")).toEqual(before);
});

const routeTo = async (table: string, action: DocumentConfig["actions"][number]) => {
  config = {
    ...config,
    actions: [...config.actions, action],
    entities: config.entities.map((e) =>
      e.table === table ? { ...e, concurrency: "customAction", actionId: action.id } : e,
    ),
  };
  await invoke("update_document_config", { windowLabel: W, config });
};

it("app-mode trigger writes routed to a custom action run under the trigger's grant", async () => {
  await routeTo("inventory", {
    id: "a-guard",
    name: "Guard stock",
    onError: "stop",
    steps: [
      {
        id: "g-upd",
        kind: "updateRecord",
        table: "inventory",
        match: "current",
        values: { qty: "record.qty" },
      },
      { id: "g-log", kind: "createRecord", table: "audit_log", values: { message: "'guarded'" } },
    ],
  });
  await insertRecord("orders", [text("status", "new")]);
  expect(await rows("inventory")).toEqual([[1, "9"]]);
  expect(await rows("audit_log")).toEqual([
    [1, "guarded"],
    [2, "ok"],
  ]);
});

it("Rust authorizes the writes of a custom action a save is routed to", async () => {
  await insertRecord("orders", [text("status", "new")]);
  config = { ...config, triggers: [] };
  await routeTo("orders", {
    id: "a-order",
    name: "Guard order",
    onError: "rollback",
    steps: [
      {
        id: "o-upd",
        kind: "updateRecord",
        table: "orders",
        match: "current",
        values: { status: "record.status" },
      },
      { id: "o-log", kind: "createRecord", table: "audit_log", values: { message: "'changed'" } },
    ],
  });
  const before = [await rows("orders"), await rows("audit_log")];
  const uninstallCustom = installCustomActions(env);
  const error = await updateRecord("orders", [text("status", "changed")], [value("integer", 1)], {
    expected: [text("status", "new")],
  }).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  uninstallCustom();
  expect(error).toMatch(/cannot create table "audit_log"/);
  expect([await rows("orders"), await rows("audit_log")]).toEqual(before);
});

it("gates checkpoints, installation reset and schema listing by role", async () => {
  expect(await codeOf(invoke("create_checkpoint", { windowLabel: W, reason: "x" }))).toBe(
    "FORBIDDEN",
  );
  expect(
    await codeOf(
      invoke("restore_checkpoint_as_copy", {
        windowLabel: W,
        checkpointId: "c",
        path: "/tmp/x.ixt",
      }),
    ),
  ).toBe("FORBIDDEN");
  expect(
    await codeOf(invoke("reset_runtime_installation_data", { windowLabel: W, confirmed: true })),
  ).toBe("FORBIDDEN");
  const objects = await invoke<{ name: string }[]>("list_database_objects", { windowLabel: W });
  expect(objects.map((o) => o.name)).toEqual(["orders"]);
  expect(await codeOf(invoke("inspect_table", { windowLabel: W, table: "inventory" }))).toBe(
    "FORBIDDEN",
  );
  expect(await codeOf(invoke("inspect_table", { windowLabel: W, table: "orders" }))).toBe("OK");
  await invoke("set_runtime_role_preview", { windowLabel: W, roleId: null });
  expect(await codeOf(invoke("create_checkpoint", { windowLabel: W, reason: "x" }))).toBe("OK");
  const all = await invoke<{ name: string }[]>("list_database_objects", { windowLabel: W });
  expect(all.map((o) => o.name).sort()).toEqual(["audit_log", "inventory", "orders"]);
});
