import { beforeEach, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("../../src/lib/api", () => ({ call: (...args: unknown[]) => call(...args) }));

const { deleteRecord, insertRecord, registerRecordHook, updateRecord } = await import(
  "../../src/lib/records"
);

beforeEach(() => call.mockReset());

it("runs before hooks, the command, then after hooks with the result", async () => {
  const events: string[] = [];
  call.mockImplementation(async (command: string) => {
    events.push(command);
    return [{ type: "integer", value: 7 }];
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
  expect(call).toHaveBeenCalledWith("insert_row", { table: "people", values });
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
  call.mockResolvedValue(1);
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
  });
});
