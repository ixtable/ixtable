import { beforeEach, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("../../src/lib/api", () => ({ call: (...args: unknown[]) => call(...args) }));

const {
  deleteRecord,
  insertRecord,
  RECORDS_CHANGED_EVENT,
  registerRecordHook,
  updateRecord,
  writeRecordBatch,
} = await import("../../src/lib/records");

beforeEach(() => call.mockReset());

it("runs before hooks, the command, then after hooks with the result", async () => {
  const events: string[] = [];
  call.mockImplementation(async (command: string) => {
    events.push(command);
    return { changed: 1, identity: [{ type: "integer", value: 7 }] };
  });
  const unregister = registerRecordHook({
    before: (write) => {
      events.push(`before ${write.operation} ${write.table}`);
    },
    after: (write, result) => {
      events.push(`after ${write.operation} ${JSON.stringify(result)}`);
    },
  });
  const values = [{ column: "name", value: { type: "text" as const, value: "A" } }];
  await expect(insertRecord("people", values)).resolves.toEqual([{ type: "integer", value: 7 }]);
  expect(call).toHaveBeenCalledWith("insert_row", { table: "people", values, trigger: null });
  expect(events).toEqual([
    "before insert people",
    "insert_row",
    'after insert [{"type":"integer","value":7}]',
  ]);
  unregister();
});

it("aborts the write when a before hook throws", async () => {
  const unregister = registerRecordHook({
    before: () => {
      throw new Error("blocked by trigger");
    },
  });
  await expect(deleteRecord("people", [{ type: "integer", value: 1 }])).rejects.toThrow(
    "blocked by trigger",
  );
  expect(call).not.toHaveBeenCalled();
  unregister();
});

it("passes identity and values for updates and stops calling unregistered hooks", async () => {
  call.mockResolvedValue({ changed: 1 });
  const after = vi.fn();
  const unregister = registerRecordHook({ after });
  const identity = [{ type: "integer" as const, value: 3 }];
  const values = [{ column: "score", value: { type: "real" as const, value: 2.5 } }];
  await updateRecord("people", values, identity);
  expect(call).toHaveBeenCalledWith("update_row", {
    table: "people",
    values,
    identity,
    expected: null,
    trigger: null,
  });
  expect(after).toHaveBeenCalledWith(
    {
      operation: "update",
      table: "people",
      values,
      identity,
      meta: { writeId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    },
    1,
    undefined,
  );
  await updateRecord("people", values, identity);
  await updateRecord("people", values, identity, { writeId: "retry-1" });
  const ids = after.mock.calls.map(([write]) => write.meta.writeId);
  expect(new Set(ids).size).toBe(3);
  expect(ids[2]).toBe("retry-1");
  unregister();
  await deleteRecord("people", identity);
  expect(after).toHaveBeenCalledTimes(3);
  expect(call).toHaveBeenLastCalledWith("delete_row", {
    table: "people",
    identity,
    expected: null,
    trigger: null,
  });
});

it("announces committed writes once per tick, and not aborted ones", async () => {
  const seen = vi.fn();
  window.addEventListener(RECORDS_CHANGED_EVENT, seen);
  call.mockImplementation(async (command: string) =>
    command === "execute_write_batch" ? [{ changed: 1 }, { changed: 1 }] : { changed: 1 },
  );
  const identity = [{ type: "integer" as const, value: 1 }];
  await updateRecord("people", [], identity);
  await deleteRecord("people", identity);
  await writeRecordBatch([
    { operation: "delete", table: "people", values: [], identity },
    { operation: "delete", table: "people", values: [], identity },
  ]);
  await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(1));
  const unregister = registerRecordHook({
    before: () => {
      throw new Error("blocked");
    },
  });
  await expect(deleteRecord("people", identity)).rejects.toThrow("blocked");
  unregister();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(seen).toHaveBeenCalledTimes(1);
  window.removeEventListener(RECORDS_CHANGED_EVENT, seen);
});

it("passes trigger step auth to Rust and the issued grant to after hooks", async () => {
  const after = vi.fn();
  const unregister = registerRecordHook({ after });
  const identity = [{ type: "integer" as const, value: 3 }];
  const trigger = { triggerId: "t1", grant: "g0", stepId: "s1" };
  call.mockResolvedValueOnce({ changed: 1, triggerGrant: "g1" });
  await updateRecord("stock", [], identity, { trigger });
  expect(call).toHaveBeenLastCalledWith("update_row", {
    table: "stock",
    values: [],
    identity,
    expected: null,
    trigger,
  });
  expect(after.mock.calls[0][2]).toEqual({ triggerGrant: "g1" });
  call.mockResolvedValueOnce([{ changed: 1, identity, triggerGrant: "g2" }, { changed: 1 }]);
  await writeRecordBatch([
    { operation: "insert", table: "a", values: [], identity: null, meta: { trigger } },
    { operation: "delete", table: "b", values: [], identity },
  ]);
  expect(call).toHaveBeenLastCalledWith("execute_write_batch", {
    ops: [
      { op: "insert", table: "a", values: [] },
      { op: "delete", table: "b", identity, expected: null },
    ],
    triggers: [trigger, null],
  });
  expect(after.mock.calls[1].slice(1)).toEqual([identity, { triggerGrant: "g2" }]);
  expect(after.mock.calls[2].slice(1)).toEqual([1, undefined]);
  unregister();
});
