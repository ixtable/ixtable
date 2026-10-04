import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentConfig } from "../../src/lib/types";
import { createFakeBackend } from "./automation-fakes";

const state = vi.hoisted(() => ({
  backend: null as null | { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => state.backend?.invoke(command, args),
}));

const { installTriggers, MAX_TRIGGER_DEPTH } = await import("../../src/automation/triggers");
const { insertRecord, updateRecord } = await import("../../src/lib/records");
const { runNextJob } = await import("../../src/automation/worker");
const { browserContext } = await import("../../src/automation/context");
type Trigger = import("../../src/automation/types").Trigger;
type ActionDef = import("../../src/automation/types").ActionDef;

let db: ReturnType<typeof createFakeBackend>;
let config: DocumentConfig;
let uninstall: () => void;

const audit: ActionDef = {
  id: "audit",
  name: "Audit",
  onError: "stop",
  steps: [
    {
      id: "s1",
      kind: "createRecord",
      table: "audit",
      values: {
        message:
          "'order ' & record.id & ': ' & coalesce(old.status, 'new') & ' → ' & record.status",
      },
    },
  ],
};
const trigger = (t: Partial<Trigger>): Trigger => ({
  id: "t1",
  name: "Audit orders",
  table: "orders",
  event: "created",
  actionId: "audit",
  mode: "sync",
  enabled: true,
  maxAttempts: 3,
  backoffMs: 10,
  ...t,
});
const text = (value: string) => ({ type: "text" as const, value });

beforeEach(() => {
  db = createFakeBackend();
  state.backend = db;
  db.addTable("orders", ["id", "status"], [{ id: 1, status: "open" }]);
  db.addTable("audit", ["id", "message"]);
  config = { actions: [audit], triggers: [], design: { forms: [] } } as unknown as DocumentConfig;
  uninstall = installTriggers({
    getConfig: () => config,
    context: (base) => browserContext(config, () => undefined, base),
  });
});
afterEach(() => uninstall());

it("runs sync created triggers inside the write and honors conditions", async () => {
  config.triggers = [trigger({ condition: "record.status = 'open'" })];
  await insertRecord("orders", [{ column: "status", value: text("open") }]);
  await insertRecord("orders", [{ column: "status", value: text("draft") }]);
  expect(db.rows("audit").map((r) => r.message)).toEqual(["order 2: new → open"]);
});

it("gives updated triggers the old values and skips disabled ones", async () => {
  config.triggers = [
    trigger({ event: "updated" }),
    trigger({ id: "t2", event: "updated", enabled: false }),
  ];
  await updateRecord(
    "orders",
    [{ column: "status", value: text("closed") }],
    [{ type: "integer", value: 1 }],
    { old: { id: 1, status: "open" } },
  );
  expect(db.rows("audit").map((r) => r.message)).toEqual(["order 1: open → closed"]);
});

it("reads old values before an update when the caller does not pass them", async () => {
  config.triggers = [trigger({ event: "updated" })];
  await updateRecord(
    "orders",
    [{ column: "status", value: text("held") }],
    [{ type: "integer", value: 1 }],
  );
  expect(db.rows("audit").map((r) => r.message)).toEqual(["order 1: open → held"]);
});

it("propagates sync trigger failures to the caller after the write commits", async () => {
  config.actions = [{ ...audit, steps: [{ id: "x", kind: "message", text: "1 +" }] }];
  config.triggers = [trigger({})];
  await expect(insertRecord("orders", [{ column: "status", value: text("open") }])).rejects.toThrow(
    /Trigger "Audit orders" failed/,
  );
  expect(db.rows("orders")).toHaveLength(2);
});

it("stops trigger recursion at the depth limit", async () => {
  config.actions = [
    {
      id: "loop",
      name: "Loop",
      onError: "stop",
      steps: [{ id: "s", kind: "createRecord", table: "orders", values: { status: "'again'" } }],
    },
  ];
  config.triggers = [trigger({ actionId: "loop" })];
  await expect(insertRecord("orders", [{ column: "status", value: text("seed") }])).rejects.toThrow(
    new RegExp(`recursion limit \\(${MAX_TRIGGER_DEPTH}\\)`),
  );
  expect(db.rows("orders")).toHaveLength(1 + 1 + MAX_TRIGGER_DEPTH);
});

it("enqueues async triggers once per write and the worker runs them", async () => {
  config.triggers = [trigger({ mode: "async", event: "updated" })];
  const write = (writeId?: string) =>
    updateRecord(
      "orders",
      [{ column: "status", value: text("closed") }],
      [{ type: "integer", value: 1 }],
      { old: { id: 1, status: "open" }, ...(writeId && { writeId }) },
    );
  await write("w-1");
  await write("w-1");
  expect(db.jobs).toHaveLength(1);
  expect(db.jobs[0]).toMatchObject({
    triggerId: "t1",
    actionId: "audit",
    maxAttempts: 3,
    backoffMs: 10,
    payload: { table: "orders", event: "updated", record: { id: 1, status: "closed" } },
  });
  expect(String(db.jobs[0].idempotencyKey)).toMatch(/^t1:orders:1:updated:[0-9a-f]{8}:w-1$/);
  expect(db.rows("audit")).toEqual([]);

  const job = db.jobs[0];
  const done = vi.fn();
  db.on("claim_next_job", () =>
    job.status === "queued" ? ((job.status = "running"), { ...job, leaseToken: "1:abc" }) : null,
  );
  db.on("complete_job", ({ id, leaseToken, log }) => done(id, leaseToken, log));
  await runNextJob({ getConfig: () => config });
  expect(done).toHaveBeenCalledWith(
    "job1",
    "1:abc",
    expect.objectContaining({ steps: expect.any(Array) }),
  );
  expect(db.rows("audit").map((r) => r.message)).toEqual(["order 1: open → closed"]);
  expect(await runNextJob({ getConfig: () => config })).toBeNull();
});

it("uses a custom idempotency key expression and reports worker failures", async () => {
  config.triggers = [
    trigger({ mode: "async", idempotencyKey: "'order-' & record.id & '-' & trigger.id" }),
  ];
  await insertRecord("orders", [{ column: "status", value: text("open") }]);
  expect(db.jobs[0].idempotencyKey).toBe("order-2-t1");
  config.actions = [];
  const job = db.jobs[0];
  const failed = vi.fn();
  db.on("claim_next_job", () => (job.status === "queued" ? ((job.status = "running"), job) : null));
  db.on("fail_job", ({ id, error }) => failed(id, error));
  await runNextJob({ getConfig: () => config });
  expect(failed).toHaveBeenCalledWith("job1", "Action audit does not exist");
});

it("enqueues a later identical write as a new event", async () => {
  config.triggers = [trigger({ mode: "async", event: "updated" })];
  const write = () =>
    updateRecord(
      "orders",
      [{ column: "status", value: text("closed") }],
      [{ type: "integer", value: 1 }],
      { old: { id: 1, status: "open" } },
    );
  await write();
  await write();
  expect(db.jobs).toHaveLength(2);
  expect(db.jobs[0].idempotencyKey).not.toBe(db.jobs[1].idempotencyKey);
});

it("ignores a stale lease instead of recording a failure", async () => {
  config.triggers = [trigger({ mode: "async" })];
  await insertRecord("orders", [{ column: "status", value: text("open") }]);
  const job = db.jobs[0];
  const failed = vi.fn();
  db.on("claim_next_job", () =>
    job.status === "queued" ? ((job.status = "running"), { ...job, leaseToken: "1:old" }) : null,
  );
  db.on("complete_job", () => {
    throw { code: "STALE_LEASE", message: "Job job1 is cancelled" };
  });
  db.on("fail_job", ({ id }) => failed(id));
  await runNextJob({ getConfig: () => config });
  expect(failed).not.toHaveBeenCalled();
});
