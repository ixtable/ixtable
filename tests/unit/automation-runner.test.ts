import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentConfig } from "../../src/lib/types";
import { createFakeBackend } from "./automation-fakes";

const state = vi.hoisted(() => ({
  backend: null as null | { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> },
  query: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => state.backend?.invoke(command, args),
}));
vi.mock("../../src/query/api", () => ({ runSavedQuery: state.query }));

const { runAction } = await import("../../src/automation/runner");
const { registerRecordHook } = await import("../../src/lib/records");
const { headlessContext } = await import("../../src/automation/worker");
type ActionDef = import("../../src/automation/types").ActionDef;
type Step = import("../../src/automation/types").Step;
type ActionContext = import("../../src/automation/runner").ActionContext;

let db: ReturnType<typeof createFakeBackend>;
let n = 0;
const step = (s: Omit<Step, "id"> & { id?: string }): Step => ({ id: `s${++n}`, ...s }) as Step;
const action = (steps: Step[], extra: Partial<ActionDef> = {}): ActionDef => ({
  id: extra.id ?? `a${++n}`,
  name: extra.name ?? "Test action",
  steps,
  onError: "stop",
  ...extra,
});
const baseConfig = (actions: ActionDef[] = []): DocumentConfig =>
  ({
    actions,
    triggers: [],
    savedQueries: [{ id: "q1", name: "Open orders", sql: "select 1" }],
    design: { version: 2, forms: [{ id: "f1", name: "Orders" }], navigation: [] },
    reports: [{ id: "r1", name: "Invoice" }],
    dashboards: [],
  }) as unknown as DocumentConfig;

function context(config: DocumentConfig, extra: Partial<ActionContext> = {}) {
  const events: unknown[] = [];
  const ctx: ActionContext = {
    config,
    app: { user: "ana" },
    navigate: (target) => events.push(["navigate", target]),
    setState: (scope, key, value) => events.push(["state", scope, key, value]),
    confirm: async (message) => {
      events.push(["confirm", message]);
      return true;
    },
    notify: (message, tone) => events.push(["notify", message, tone]),
    ...extra,
  };
  return { ctx, events };
}

beforeEach(() => {
  db = createFakeBackend();
  state.backend = db;
  state.query.mockReset();
  db.addTable(
    "orders",
    ["id", "status", "total"],
    [
      { id: 1, status: "open", total: 10 },
      { id: 2, status: "open", total: 20 },
    ],
  );
  db.addTable("audit", ["id", "message"], [], (row) =>
    row.message === "bad" ? "CHECK constraint failed: audit" : undefined,
  );
});

describe("steps", () => {
  it("updates the current record, creates rows, sets state and messages", async () => {
    const a = action([
      step({
        kind: "updateRecord",
        table: "orders",
        match: "current",
        values: { status: "'shipped'" },
      }),
      step({
        kind: "createRecord",
        table: "audit",
        values: { message: "'order ' & record.id & ' is ' & record.status" },
        storeAs: "entry",
      }),
      step({ kind: "setState", scope: "app", key: "last", value: "results.entry.id" }),
      step({ kind: "message", text: "'Logged ' & app.last & ' by ' & app.user", tone: "info" }),
    ]);
    const { ctx, events } = context(baseConfig([a]), { record: { id: 1, status: "open" } });
    const result = await runAction(a, ctx);
    expect(result).toMatchObject({ ok: true });
    expect(db.rows("orders")[0].status).toBe("shipped");
    expect(db.rows("audit")).toEqual([{ id: 1, message: "order 1 is shipped" }]);
    expect(events).toEqual([
      ["state", "app", "last", 1],
      ["notify", "Logged 1 by ana", "info"],
    ]);
    expect(result.steps.map((s) => [s.kind, s.ok])).toEqual([
      ["updateRecord", true],
      ["createRecord", true],
      ["setState", true],
      ["message", true],
    ]);
    expect(result.steps.every((s) => s.durationMs >= 0)).toBe(true);
  });

  it("matches rows by expression, deletes them, and fails explicitly when nothing matches", async () => {
    const a = action([
      step({ kind: "deleteRecord", table: "orders", match: { status: "params.status" } }),
    ]);
    const { ctx } = context(baseConfig([a]), { params: { status: "open" } });
    expect((await runAction(a, ctx)).ok).toBe(true);
    expect(db.rows("orders")).toEqual([]);
    const again = await runAction(a, ctx);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/No orders rows match/);
  });

  it("skips steps whose when is false and branches on conditions", async () => {
    const a = action([
      step({ kind: "message", text: "'skipped'", when: "record.total > 100" }),
      step({
        kind: "condition",
        when: "record.total > 5",
        then: [step({ kind: "message", text: "'big'" })],
        else: [step({ kind: "message", text: "'small'" })],
      }),
    ]);
    const { ctx, events } = context(baseConfig([a]), { record: { id: 1, total: 10 } });
    const result = await runAction(a, ctx);
    expect(events).toEqual([["notify", "big", "info"]]);
    expect(result.steps[0]).toMatchObject({ skipped: true, ok: true });
    expect(result.steps.map((s) => s.path)).toEqual(["0", "1", "1.then.0"]);
  });

  it("runs saved queries and stores rows for later steps", async () => {
    state.query.mockResolvedValue({
      columns: ["id", "total"],
      rows: [
        [
          { type: "integer", value: 1 },
          { type: "real", value: 10.5 },
        ],
        [
          { type: "integer", value: 2 },
          { type: "real", value: 4.5 },
        ],
      ],
    });
    const a = action([
      step({ kind: "runQuery", queryId: "q1", params: { min: "params.min" }, storeAs: "open" }),
      step({ kind: "message", text: "'Total ' & sum(results.open.total)" }),
    ]);
    const { ctx, events } = context(baseConfig([a]), { params: { min: 3 } });
    expect((await runAction(a, ctx)).ok).toBe(true);
    expect(state.query).toHaveBeenCalledWith("q1", { min: 3 });
    expect(events).toEqual([["notify", "Total 15", "info"]]);
  });

  it("navigates to existing targets and rejects missing ones", async () => {
    const a = action([
      step({ kind: "openForm", formId: "f1", mode: "edit", recordId: "record.id" }),
      step({ kind: "openReport", reportId: "r1", params: { id: "record.id" } }),
      step({ kind: "navigate", target: { kind: "dashboard", id: "nope" } }),
    ]);
    const { ctx, events } = context(baseConfig([a]), { record: { id: 7 } });
    const result = await runAction(a, ctx);
    expect(events).toEqual([
      ["navigate", { kind: "form", id: "f1", mode: "edit", recordId: 7 }],
      ["navigate", { kind: "report", id: "r1", params: { id: 7 } }],
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dashboard nope does not exist/);
  });

  it("reports empty and invalid expressions as step failures", async () => {
    const empty = action([step({ kind: "message", text: " " })]);
    const { ctx } = context(baseConfig([empty]));
    expect((await runAction(empty, ctx)).error).toMatch(/Message has no expression/);
    const bad = action([step({ kind: "message", text: "1 +" })]);
    expect((await runAction(bad, ctx)).ok).toBe(false);
  });
});

describe("failure behavior", () => {
  const failing = () =>
    step({ kind: "createRecord", table: "audit", values: { message: "'bad'" } });

  it("stop: ends at the first failure and keeps earlier writes", async () => {
    const a = action([
      step({ kind: "createRecord", table: "audit", values: { message: "'first'" } }),
      failing(),
      step({ kind: "createRecord", table: "audit", values: { message: "'never'" } }),
    ]);
    const result = await runAction(a, context(baseConfig([a])).ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Step 2 \(createRecord\) failed: CHECK constraint failed/);
    expect(db.rows("audit").map((r) => r.message)).toEqual(["first"]);
    expect(result.steps).toHaveLength(2);
  });

  it("continue: logs the failure and runs the remaining steps", async () => {
    const a = action(
      [failing(), step({ kind: "createRecord", table: "audit", values: { message: "'after'" } })],
      { onError: "continue" },
    );
    const result = await runAction(a, context(baseConfig([a])).ctx);
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.ok)).toEqual([false, true]);
    expect(db.rows("audit").map((r) => r.message)).toEqual(["after"]);
  });

  it("rollback: a failing step saves none of the writes and holds back effects", async () => {
    const a = action(
      [
        step({ kind: "createRecord", table: "audit", values: { message: "'temp'" } }),
        step({
          kind: "updateRecord",
          table: "orders",
          match: { id: "1" },
          values: { total: "99" },
        }),
        step({ kind: "deleteRecord", table: "orders", match: { id: "2" } }),
        step({ kind: "message", text: "'saved'" }),
        step({ kind: "message", text: "1 +" }),
      ],
      { onError: "rollback" },
    );
    const { ctx, events } = context(baseConfig([a]));
    const result = await runAction(a, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Step 5 \(message\) failed: .*; no record changes were saved/);
    expect(db.rows("audit")).toEqual([]);
    expect(db.rows("orders")).toHaveLength(2);
    expect(events).toEqual([]);
    expect(db.calls.some((c) => c.command === "execute_write_batch")).toBe(false);
  });

  it("fail: aborts with the evaluated message and, under rollback, commits nothing", async () => {
    const a = action(
      [
        step({ kind: "createRecord", table: "audit", values: { message: "'temp'" } }),
        step({ kind: "message", text: "'saved'" }),
        step({
          kind: "condition",
          when: "record.total > 5",
          then: [step({ kind: "fail", message: "'Total ' & record.total & ' is over the limit'" })],
          else: [],
        }),
        step({ kind: "message", text: "'not reached'" }),
      ],
      { onError: "rollback" },
    );
    const { ctx, events } = context(baseConfig([a]), { record: { id: 1, total: 10 } });
    const result = await runAction(a, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Total 10 is over the limit; no record changes were saved");
    expect(db.rows("audit")).toEqual([]);
    expect(events).toEqual([]);
    expect(result.steps.map((s) => [s.path, s.kind, s.ok])).toEqual([
      ["0", "createRecord", true],
      ["1", "message", true],
      ["2", "condition", false],
      ["2.then.0", "fail", false],
    ]);
  });

  it("fail: stops even under onError=continue, skips when `when` is false, and propagates from nested actions", async () => {
    const child = action([step({ kind: "fail", message: "'Credit limit reached'" })], {
      id: "child",
    });
    const skipped = action(
      [
        step({ kind: "fail", message: "'never'", when: "false" }),
        step({ kind: "message", text: "'done'" }),
      ],
      { onError: "continue" },
    );
    const parent = action(
      [
        step({ kind: "runAction", actionId: "child" }),
        step({ kind: "message", text: "'not reached'" }),
      ],
      { onError: "continue" },
    );
    const config = baseConfig([child, skipped, parent]);
    const first = context(config);
    expect(await runAction(skipped, first.ctx)).toMatchObject({ ok: true });
    expect(first.events).toEqual([["notify", "done", "info"]]);
    const second = context(config);
    const result = await runAction(parent, second.ctx);
    expect(result).toMatchObject({ ok: false, error: "Credit limit reached" });
    expect(second.events).toEqual([]);
  });

  it("rollback: commits all writes in one batch, then runs effects and after hooks", async () => {
    const seen: string[] = [];
    const off = registerRecordHook({
      before: (w) => void seen.push(`before ${w.operation}`),
      after: (w, r) => void seen.push(`after ${w.operation} ${JSON.stringify(r)}`),
    });
    const a = action(
      [
        step({ kind: "createRecord", table: "audit", values: { message: "'ok'" } }),
        step({ kind: "updateRecord", table: "orders", match: "current", values: { total: "99" } }),
        step({ kind: "message", text: "'saved'" }),
      ],
      { onError: "rollback" },
    );
    const { ctx, events } = context(baseConfig([a]), { record: { id: 1 } });
    const result = await runAction(a, ctx);
    off();
    expect(result.ok).toBe(true);
    expect(db.calls.filter((c) => c.command === "execute_write_batch")).toHaveLength(1);
    expect(db.rows("audit")).toEqual([{ id: 1, message: "ok" }]);
    expect(db.rows("orders")[0].total).toBe(99);
    expect(events).toEqual([["notify", "saved", "info"]]);
    expect(seen).toEqual([
      "before insert",
      "before update",
      'after insert [{"type":"integer","value":1}]',
      "after update 1",
    ]);
  });

  it("rollback: a failing commit saves nothing", async () => {
    const a = action(
      [
        step({ kind: "updateRecord", table: "orders", match: { id: "1" }, values: { total: "5" } }),
        failing(),
        step({ kind: "message", text: "'saved'" }),
      ],
      { onError: "rollback" },
    );
    const { ctx, events } = context(baseConfig([a]));
    const result = await runAction(a, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Transaction failed: CHECK constraint failed.*no record changes/);
    expect(db.rows("orders")[0].total).toBe(10);
    expect(db.rows("audit")).toEqual([]);
    expect(events).toEqual([]);
  });

  it("a declined confirm cancels and rolls back", async () => {
    const a = action(
      [
        step({ kind: "createRecord", table: "audit", values: { message: "'pending'" } }),
        step({ kind: "confirm", message: "'Close order ' & record.id & '?'" }),
        step({ kind: "message", text: "'done'" }),
      ],
      { onError: "rollback" },
    );
    const { ctx, events } = context(baseConfig([a]), {
      record: { id: 3 },
      confirm: async (m) => {
        events.push(["confirm", m]);
        return false;
      },
    });
    const result = await runAction(a, ctx);
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(events).toEqual([["confirm", "Close order 3?"]]);
    expect(db.rows("audit")).toEqual([]);
  });
});

describe("composition and permissions", () => {
  it("runs nested actions inside the caller's transaction", async () => {
    const child = action(
      [step({ kind: "createRecord", table: "audit", values: { message: "'child'" } })],
      { id: "child", name: "Child" },
    );
    const parent = action(
      [step({ kind: "runAction", actionId: "child" }), step({ kind: "message", text: "1 +" })],
      { id: "parent", name: "Parent", onError: "rollback" },
    );
    const result = await runAction("parent", context(baseConfig([child, parent])).ctx);
    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => s.path)).toEqual(["0", "0.action.0", "1"]);
    expect(db.rows("audit")).toEqual([]);
  });

  it("stops recursive runAction cycles", async () => {
    const a = action([step({ kind: "runAction", actionId: "b" })], { id: "a", name: "A" });
    const b = action([step({ kind: "runAction", actionId: "a" })], { id: "b", name: "B" });
    const result = await runAction("a", context(baseConfig([a, b])).ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Recursive action call: A → B → A/);
  });

  it("denies unauthorized actions and writes", async () => {
    const a = action([step({ kind: "deleteRecord", table: "orders", match: { id: "1" } })]);
    const denyAll = context(baseConfig([a]), { authorize: () => false }).ctx;
    expect(await runAction(a, denyAll)).toMatchObject({ ok: false, error: "Not permitted" });
    const denyDelete = context(baseConfig([a]), {
      authorize: (_kind, _id, op) => op !== "delete",
    }).ctx;
    const result = await runAction(a, denyDelete);
    expect(result.error).toMatch(/Not permitted/);
    expect(db.rows("orders")).toHaveLength(2);
  });

  it("returns an error for unknown actions", async () => {
    expect(await runAction("missing", context(baseConfig()).ctx)).toMatchObject({
      ok: false,
      error: "Action missing does not exist",
    });
  });

  it("headless contexts fail navigation and confirmation clearly", async () => {
    const config = baseConfig();
    const messages: { text: string; tone: string }[] = [];
    const ctx = headlessContext(config, { record: { id: 1 } }, {}, messages);
    const nav = action([step({ kind: "openForm", formId: "f1" })]);
    expect((await runAction(nav, ctx)).error).toMatch(
      /Navigation is not available in background jobs/,
    );
    const ask = action([step({ kind: "confirm", message: "'ok?'" })]);
    expect((await runAction(ask, ctx)).error).toMatch(/Confirmation is not available/);
    const say = action([step({ kind: "message", text: "'hi ' & record.id" })]);
    expect((await runAction(say, ctx)).ok).toBe(true);
    expect(messages).toEqual([{ text: "hi 1", tone: "info" }]);
  });
});
