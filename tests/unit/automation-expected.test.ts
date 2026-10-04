import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentConfig, NamedValue } from "../../src/lib/types";
import { createFakeBackend } from "./automation-fakes";

const state = vi.hoisted(() => ({
  backend: null as null | { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => state.backend?.invoke(command, args),
}));

const { runAction } = await import("../../src/automation/runner");
const { installCustomActions } = await import("../../src/automation/custom");
const { browserContext } = await import("../../src/automation/context");
const { updateRecord } = await import("../../src/lib/records");
const { afterWrite } = await import("../../src/automation/rows");
type ActionDef = import("../../src/automation/types").ActionDef;
type Step = import("../../src/automation/types").Step;
type ActionContext = import("../../src/automation/runner").ActionContext;

let db: ReturnType<typeof createFakeBackend>;
let config: DocumentConfig;
let cleanup: (() => void)[] = [];

const action = (steps: Step[], extra: Partial<ActionDef> = {}): ActionDef => ({
  id: "a",
  name: "a",
  steps,
  onError: "stop",
  ...extra,
});
const ctx = (extra: Partial<ActionContext> = {}): ActionContext => ({
  config,
  app: {},
  navigate: () => undefined,
  setState: () => undefined,
  confirm: async () => true,
  notify: () => undefined,
  ...extra,
});
const text = (value: string) => ({ type: "text" as const, value });
const int = (value: number) => ({ type: "integer" as const, value });
const update = (id: string, values: Record<string, string>): Step => ({
  id,
  kind: "updateRecord",
  table: "orders",
  match: "current",
  values,
});
const remove = (id: string): Step => ({
  id,
  kind: "deleteRecord",
  table: "orders",
  match: "current",
});

beforeEach(() => {
  db = createFakeBackend();
  state.backend = db;
  db.addTable("orders", ["id", "status", "note"], [{ id: 1, status: "open", note: "n" }]);
  config = {
    actions: [],
    triggers: [],
    entities: [],
    design: { forms: [] },
    reports: [],
    dashboards: [],
  } as unknown as DocumentConfig;
  const env = {
    getConfig: () => config,
    context: (base: Partial<ActionContext>) => browserContext(config, () => undefined, base),
  };
  cleanup = [installCustomActions(env)];
});
afterEach(() => {
  for (const off of cleanup) off();
});

describe("rows written twice in one run", () => {
  it("carries post-write values forward in a rollback transaction", async () => {
    const a = action([update("s1", { status: "'approved'" }), update("s2", { note: "'done'" })], {
      onError: "rollback",
    });
    expect(await runAction(a, ctx({ record: { id: 1 } }))).toMatchObject({ ok: true });
    expect(db.rows("orders")[0]).toMatchObject({ status: "approved", note: "done" });
  });

  it("deletes a row updated earlier in the same transaction", async () => {
    const a = action([update("s1", { status: "'approved'" }), remove("s2")], {
      onError: "rollback",
    });
    expect(await runAction(a, ctx({ record: { id: 1 } }))).toMatchObject({ ok: true });
    expect(db.rows("orders")).toHaveLength(0);
  });

  it("fails clearly on a row deleted earlier in the run", async () => {
    const a = action([remove("s1"), update("s2", { note: "'x'" })], { onError: "rollback" });
    const result = await runAction(a, ctx({ record: { id: 1 } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already deleted by this action");
    expect(db.rows("orders")).toHaveLength(1);
  });

  it("updates the same row twice with immediate writes", async () => {
    const a = action([update("s1", { status: "'approved'" }), update("s2", { note: "'done'" })]);
    expect(await runAction(a, ctx({ record: { id: 1 } }))).toMatchObject({ ok: true });
    expect(db.rows("orders")[0]).toMatchObject({ status: "approved", note: "done" });
  });

  it("afterWrite overlays written columns only", () => {
    expect(
      afterWrite(
        [
          { column: "id", value: int(1) },
          { column: "status", value: text("open") },
        ],
        [{ column: "status", value: text("x") }],
      ),
    ).toEqual([
      { column: "id", value: int(1) },
      { column: "status", value: text("x") },
    ]);
  });
});

describe("custom actions on the current row", () => {
  beforeEach(() => {
    config.actions = [action([update("c1", { status: "params.changes.status" })])];
    config.entities = [
      { id: "e1", table: "orders", concurrency: "customAction", actionId: "a" },
    ] as unknown as DocumentConfig["entities"];
  });

  it("conflicts when the row changed after the form loaded it", async () => {
    const loaded = { id: 1, status: "open", note: "n" };
    db.rows("orders")[0].note = "changed elsewhere";
    const expected: NamedValue[] = [
      { column: "id", value: int(1) },
      { column: "status", value: text("open") },
      { column: "note", value: text("n") },
    ];
    await expect(
      updateRecord("orders", [{ column: "status", value: text("x") }], [int(1)], {
        old: loaded,
        expected,
      }),
    ).rejects.toThrow(/changed/);
    expect(db.rows("orders")[0]).toMatchObject({ status: "open", note: "changed elsewhere" });
  });

  it("conflicts from the stale old snapshot when no expected is given", async () => {
    db.rows("orders")[0].note = "changed elsewhere";
    await expect(
      updateRecord("orders", [{ column: "status", value: text("x") }], [int(1)], {
        old: { id: 1, status: "open", note: "n" },
      }),
    ).rejects.toThrow(/changed/);
  });

  it("writes when the grid passes no snapshot", async () => {
    await updateRecord("orders", [{ column: "status", value: text("x") }], [int(1)]);
    expect(db.rows("orders")[0].status).toBe("x");
  });
});

describe("tables without a primary key", () => {
  beforeEach(() => {
    db.tables.orders.columns = db.tables.orders.columns.map((c) => ({ ...c, pk: 0 }));
  });

  it("sends the loaded snapshot, not unsaved edits, as expected", async () => {
    const a = action([update("s1", { status: "'approved'" })]);
    const result = await runAction(
      a,
      ctx({
        record: { rowid: 1, id: 1, status: "open", note: "unsaved edit" },
        snapshot: { rowid: 1, id: 1, status: "open", note: "n" },
      }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(db.rows("orders")[0].status).toBe("approved");
  });

  it("updates the same keyless row twice", async () => {
    const a = action([update("s1", { status: "'approved'" }), update("s2", { note: "'done'" })]);
    const record = { rowid: 1, id: 1, status: "open", note: "n" };
    expect(await runAction(a, ctx({ record, snapshot: record }))).toMatchObject({ ok: true });
    expect(db.rows("orders")[0]).toMatchObject({ status: "approved", note: "done" });
  });
});
