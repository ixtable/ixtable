import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ command: string; args: Record<string, unknown> }>);
const role = vi.hoisted(() => ({ restricted: false }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    const cell = (n: number) => [{ type: "integer", value: n }];
    if (command === "execute_parameterized_query") {
      if (role.restricted)
        throw { code: "FORBIDDEN", message: 'The role "Clerk" cannot run ad hoc SQL' };
      return { columns: ["n"], rows: [cell(1)], truncated: false, rowLimit: 5, elapsedMs: 1 };
    }
    if (command === "read_table_page") {
      const offset = Number(args.offset);
      const count = Math.max(0, Math.min(Number(args.limit), 2500 - offset));
      return {
        columns: [{ name: "n" }],
        rows: Array.from({ length: count }, (_, i) => cell(offset + i)),
        identities: [],
        total: 2500,
        offset,
        limit: args.limit,
      };
    }
    throw new Error(`unexpected ${command}`);
  },
}));

const { loadDataset } = await import("../../src/reports/data");
const report = { id: "r", name: "Numbers", table: "numbers" } as never;

beforeEach(() => {
  calls.length = 0;
  role.restricted = false;
});

it("reads a table report with ad hoc SQL for the developer", async () => {
  const result = await loadDataset(report, {} as never, {}, undefined, 5);
  expect(result?.rows).toHaveLength(1);
  expect(calls.map((c) => c.command)).toEqual(["execute_parameterized_query"]);
});

it("pages through the table when a runtime role may not run ad hoc SQL", async () => {
  role.restricted = true;
  const result = await loadDataset(report, {} as never, {}, undefined, 2200);
  expect(result?.columns).toEqual(["n"]);
  expect(result?.rows).toHaveLength(2200);
  expect(result?.truncated).toBe(true);
  const pages = calls.filter((c) => c.command === "read_table_page");
  expect(pages.map((c) => [c.args.offset, c.args.limit])).toEqual([
    [0, 1000],
    [1000, 1000],
    [2000, 200],
  ]);
});
