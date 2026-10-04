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
const { installTriggers } = await import("../../src/automation/triggers");
const { installCustomActions } = await import("../../src/automation/custom");
const { MAX_MATCHED_ROWS } = await import("../../src/automation/rows");
const { browserContext, NAVIGATE_EVENT, provideAppState } = await import(
  "../../src/automation/context"
);
const { deleteRecord, insertRecord, updateRecord } = await import("../../src/lib/records");
type ActionDef = import("../../src/automation/types").ActionDef;
type Step = import("../../src/automation/types").Step;
type ActionContext = import("../../src/automation/runner").ActionContext;

let db: ReturnType<typeof createFakeBackend>;
let config: DocumentConfig;
let cleanup: (() => void)[] = [];
const events: unknown[] = [];

const action = (id: string, steps: Step[], extra: Partial<ActionDef> = {}): ActionDef => ({
  id,
  name: id,
  steps,
  onError: "stop",
  ...extra,
});
const ctx = (extra: Partial<ActionContext> = {}): ActionContext => ({
  config,
  app: {},
  navigate: (t) => events.push(["navigate", t.kind, t.id]),
  setState: () => undefined,
  confirm: async () => true,
  notify: (m) => events.push(["notify", m]),
  refresh: () => events.push(["refresh"]),
  ...extra,
});
const text = (value: string) => ({ type: "text" as const, value });
const int = (value: number) => ({ type: "integer" as const, value });

beforeEach(() => {
  db = createFakeBackend();
  state.backend = db;
  events.length = 0;
  db.addTable(
    "orders",
    ["id", "status"],
    [
      { id: 1, status: "open" },
      { id: 2, status: "open" },
    ],
  );
  db.addTable("audit", ["id", "message"]);
  config = {
    actions: [],
    triggers: [],
    entities: [],
    design: { forms: [{ id: "f1", name: "Orders" }] },
    reports: [],
    dashboards: [],
  } as unknown as DocumentConfig;
  const env = {
    getConfig: () => config,
    context: (base: Partial<ActionContext>) =>
      browserContext(config, (m) => events.push(["notify", m]), base),
  };
  cleanup = [installTriggers(env), installCustomActions(env)];
});
afterEach(() => {
  for (const off of cleanup) off();
});

describe("optimistic writes from actions", () => {
  it("send the matched rows' original values as expected", async () => {
    const a = action("a", [
      {
        id: "s1",
        kind: "updateRecord",
        table: "orders",
        match: "current",
        values: { status: "'x'" },
      },
      { id: "s2", kind: "deleteRecord", table: "orders", match: { id: "2" } },
    ]);
    expect(await runAction(a, ctx({ record: { id: 1 } }))).toMatchObject({ ok: true });
    const update = db.calls.find((c) => c.command === "update_row");
    expect(update?.args.expected).toEqual([
      { column: "id", value: int(1) },
      { column: "status", value: text("open") },
    ]);
    const del = db.calls.find((c) => c.command === "delete_row");
    expect(del?.args.expected).toEqual([
      { column: "id", value: int(2) },
      { column: "status", value: text("open") },
    ]);
  });

  it("conflict when the row changed after the step read it", async () => {
    db.on("update_row", (args) => {
      const expected = args.expected as NamedValue[];
      db.rows("orders")[0].status = "shipped";
      const now = db.rows("orders")[0];
      if (expected.some((e) => now[e.column] !== (e.value as { value: unknown }).value))
        throw { code: "CONFLICT", message: "status is now shipped" };
      return 1;
    });
    const a = action("a", [
      {
        id: "s1",
        kind: "updateRecord",
        table: "orders",
        match: "current",
        values: { status: "'x'" },
      },
    ]);
    const result = await runAction(a, ctx({ record: { id: 1 } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("status is now shipped");
    expect(db.rows("orders")[0].status).toBe("shipped");
  });
});

describe("matching many rows", () => {
  it("pages through every match instead of stopping at 1,000", async () => {
    db.addTable(
      "items",
      ["id", "flag"],
      Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, flag: "a" })),
    );
    const a = action("a", [
      {
        id: "s1",
        kind: "updateRecord",
        table: "items",
        match: { flag: "'a'" },
        values: { flag: "'b'" },
      },
    ]);
    expect(await runAction(a, ctx())).toMatchObject({ ok: true });
    expect(db.rows("items").every((r) => r.flag === "b")).toBe(true);
    expect(db.calls.filter((c) => c.command === "read_table_page")).toHaveLength(3);
  });

  it("fails before writing when more rows match than the hard cap", async () => {
    db.on("read_table_page", () => ({
      columns: [{ name: "id" }],
      rows: [[int(1)]],
      identities: [[int(1)]],
      total: MAX_MATCHED_ROWS + 1,
      offset: 0,
      limit: 1000,
    }));
    const a = action("a", [
      { id: "s1", kind: "deleteRecord", table: "orders", match: { status: "'open'" } },
    ]);
    const result = await runAction(a, ctx());
    expect(result.error).toContain(`at most ${MAX_MATCHED_ROWS}`);
    expect(db.calls.some((c) => c.command === "delete_row")).toBe(false);
  });
});

describe("customAction entities", () => {
  beforeEach(() => {
    config.entities = [
      { id: "e1", table: "orders", concurrency: "customAction", actionId: "guard" },
    ] as DocumentConfig["entities"];
    config.actions = [
      action("guard", [
        {
          id: "g1",
          kind: "createRecord",
          table: "audit",
          values: {
            message:
              "params.operation & ' ' & old.status & ' → ' & coalesce(params.changes.status, '-') & ' / ' & record.status",
          },
        },
        {
          id: "g2",
          kind: "condition",
          when: "params.operation = 'update'",
          then: [
            {
              id: "g3",
              kind: "updateRecord",
              table: "orders",
              match: "current",
              values: { status: "upper(record.status)" },
            },
          ],
          else: [{ id: "g4", kind: "deleteRecord", table: "orders", match: "current" }],
        },
      ]),
    ];
  });

  it("routes updates and deletes from records.ts to the action, which writes directly", async () => {
    await updateRecord("orders", [{ column: "status", value: text("paid") }], [int(1)], {
      old: { id: 1, status: "open" },
      expected: [{ column: "status", value: text("open") }],
    });
    expect(db.rows("orders")[0].status).toBe("PAID");
    await deleteRecord("orders", [int(2)]);
    expect(db.rows("orders").map((r) => r.id)).toEqual([1]);
    expect(db.rows("audit").map((r) => r.message)).toEqual([
      "update open → paid / paid",
      "delete open → - / open",
    ]);
    await insertRecord("orders", [{ column: "status", value: text("new") }]);
    expect(db.rows("orders")).toHaveLength(2);
  });

  it("routes action steps too, joining a rollback transaction", async () => {
    const a = action(
      "caller",
      [
        {
          id: "c1",
          kind: "updateRecord",
          table: "orders",
          match: { id: "1" },
          values: { status: "'late'" },
        },
      ],
      { onError: "rollback" },
    );
    config.actions.push(a);
    expect(await runAction(a, ctx())).toMatchObject({ ok: true });
    expect(db.calls.filter((c) => c.command === "execute_write_batch")).toHaveLength(1);
    expect(db.calls.some((c) => c.command === "update_row")).toBe(false);
    expect(db.rows("orders")[0].status).toBe("LATE");
    expect(db.rows("audit")).toHaveLength(1);
  });

  it("rejects the write when the action fails", async () => {
    config.actions = [
      action("guard", [{ id: "f", kind: "fail", message: "'Use the approval form'" }]),
    ];
    await expect(
      updateRecord("orders", [{ column: "status", value: text("x") }], [int(1)]),
    ).rejects.toThrow("Use the approval form");
    expect(db.rows("orders")[0].status).toBe("open");
  });
});

describe("sync trigger failures after a commit", () => {
  it("say the changes were saved and still run held-back effects and the refresh", async () => {
    config.actions = [action("boom", [{ id: "b", kind: "fail", message: "'audit is full'" }])];
    config.triggers = [
      {
        id: "t1",
        name: "Audit orders",
        table: "orders",
        event: "updated",
        actionId: "boom",
        mode: "sync",
        enabled: true,
        maxAttempts: 1,
        backoffMs: 0,
      },
    ];
    const a = action(
      "a",
      [
        {
          id: "s1",
          kind: "updateRecord",
          table: "orders",
          match: { id: "1" },
          values: { status: "'x'" },
        },
        { id: "s2", kind: "message", text: "'Updated'" },
      ],
      { onError: "rollback" },
    );
    const result = await runAction(a, ctx());
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'The record changes were saved, but trigger "Audit orders" failed: audit is full',
    );
    expect(result.error).not.toContain("no record changes were saved");
    expect(db.rows("orders")[0].status).toBe("x");
    expect(events).toEqual([["notify", "Updated"], ["refresh"]]);
  });

  it("direct writes report the saved record and refresh", async () => {
    config.actions = [action("boom", [{ id: "b", kind: "fail", message: "'nope'" }])];
    config.triggers = [
      {
        id: "t1",
        name: "T",
        table: "orders",
        event: "updated",
        actionId: "boom",
        mode: "sync",
        enabled: true,
        maxAttempts: 1,
        backoffMs: 0,
      },
    ];
    const a = action("a", [
      {
        id: "s1",
        kind: "updateRecord",
        table: "orders",
        match: { id: "1" },
        values: { status: "'x'" },
      },
    ]);
    const result = await runAction(a, ctx());
    expect(result.error).toContain('The record was saved, but trigger "T" failed: nope');
    expect(events).toEqual([["refresh"]]);
  });
});

describe("browser contexts", () => {
  it("hand navigation to a listening host and report it when nobody listens", () => {
    const notices: string[] = [];
    const c = browserContext(config, (m) => notices.push(m));
    c.navigate({ kind: "form", id: "f1" });
    expect(notices[0]).toContain("Open it in the Runtime");
    const seen: unknown[] = [];
    const listen = (e: Event) => {
      seen.push((e as CustomEvent).detail);
      e.preventDefault();
    };
    window.addEventListener(NAVIGATE_EVENT, listen);
    c.navigate({ kind: "form", id: "f1" });
    window.removeEventListener(NAVIGATE_EVENT, listen);
    expect(seen).toEqual([{ kind: "form", id: "f1" }]);
    expect(notices).toHaveLength(1);
  });

  it("give actions the host's app state", () => {
    const release = provideAppState(() => ({ region: "EU" }));
    expect(browserContext(config, () => undefined).app).toEqual({ region: "EU" });
    release();
    expect(browserContext(config, () => undefined).app).toEqual({});
  });
});

describe("queue polling", () => {
  it("sees queued jobs even when no async trigger is enabled", async () => {
    const { hasQueuedJobs } = await import("../../src/automation/api");
    const queued: unknown[] = [];
    db.on("list_jobs", ({ filter }) => {
      expect(filter).toMatchObject({ status: "queued", limit: 1 });
      return queued;
    });
    expect(await hasQueuedJobs()).toBe(false);
    queued.push({ id: "job1", status: "queued" });
    expect(await hasQueuedJobs()).toBe(true);
  });
});
