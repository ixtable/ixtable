import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignForm } from "../../src/design/schema";

const reads: Array<{ offset: number; limit: number }> = [];
const queryCalls: Array<Record<string, unknown>> = [];
let size = 0;
vi.mock("../../src/lib/api", () => ({
  call: async (command: string, args: Record<string, unknown>) => {
    if (command !== "run_saved_query_page") throw new Error(command);
    queryCalls.push(args);
    const offset = args.offset as number;
    const count = Math.max(0, Math.min(args.limit as number, size - offset));
    return {
      columns: ["n"],
      rows: Array.from({ length: count }, (_, i) => [{ type: "integer", value: offset + i }]),
      total: size,
      offset,
      limit: args.limit,
    };
  },
  inspectTable: async (name: string) => ({
    name,
    columns: [{ name: "n", declaredType: "INTEGER", primaryKeyPosition: 1 }],
    foreignKeys: [],
  }),
  readTablePage: async (_table: string, options: { offset: number; limit: number }) => {
    reads.push({ offset: options.offset, limit: options.limit });
    const count = Math.max(0, Math.min(options.limit, size - options.offset));
    return {
      columns: [{ name: "n", declaredType: "INTEGER" }],
      rows: Array.from({ length: count }, (_, i) => [
        { type: "integer", value: options.offset + i },
      ]),
      identities: Array.from({ length: count }, (_, i) => [
        { type: "integer", value: options.offset + i },
      ]),
      total: size,
      offset: options.offset,
      limit: options.limit,
    };
  },
}));

const { firstRecordId, invalidateRuntimeCache, loadPage, passesFilter } = await import(
  "../../src/runtime/data"
);

const form = (filter: string) =>
  ({
    id: "f",
    name: "Numbers",
    source: { kind: "table", table: "numbers" },
    filter,
    controls: [],
  }) as unknown as DesignForm;
const request = (offset: number) => ({ offset, limit: 10, sorts: [], filters: [] });

beforeEach(() => {
  reads.length = 0;
  queryCalls.length = 0;
  invalidateRuntimeCache();
});

describe("filtered table paging", () => {
  it("scans once and pages through sparse matches without rescanning", async () => {
    size = 30_000;
    const sparse = form("record.n % 1000 = 0");
    const first = await loadPage(sparse, request(0));
    expect(first.rows.map((r) => r.n)).toEqual(Array.from({ length: 10 }, (_, i) => i * 1000));
    expect(first.total).toBe(30);
    expect(first.truncated).toBe(false);
    const scanned = reads.length;
    const third = await loadPage(sparse, request(20));
    expect(third.rows.map((r) => r.n)).toEqual(
      Array.from({ length: 10 }, (_, i) => (i + 20) * 1000),
    );
    expect(reads.length).toBe(scanned);
  });

  it("rescans when the filter inputs change and after a cache invalidation", async () => {
    size = 2000;
    const filtered = form("record.n < app.max");
    expect((await loadPage(filtered, request(0), { app: { max: 5 } })).total).toBe(5);
    const scanned = reads.length;
    expect((await loadPage(filtered, request(0), { app: { max: 50 } })).total).toBe(50);
    expect(reads.length).toBeGreaterThan(scanned);
    const again = reads.length;
    invalidateRuntimeCache();
    await loadPage(filtered, request(0), { app: { max: 50 } });
    expect(reads.length).toBeGreaterThan(again);
  });

  it("marks a page truncated when the table is larger than the scan limit", async () => {
    size = 60_000;
    const page = await loadPage(form("record.n >= 49990"), request(0));
    expect(page.truncated).toBe(true);
    expect(page.total).toBe(10);
  });
});

describe("filtered query paging", () => {
  const queryForm = (filter: string) =>
    ({
      id: "q",
      name: "Numbers",
      source: { kind: "query", queryId: "q1", params: {} },
      filter,
      controls: [],
    }) as unknown as DesignForm;

  it("scans the saved query with its bound parameters and pages the matches", async () => {
    size = 1200;
    const even = queryForm("record.n % 2 = 0");
    const first = await loadPage(even, request(10), {}, { min: 3 });
    expect(first.identities).toBeNull();
    expect(first.total).toBe(600);
    expect(first.rows.map((r) => r.n)).toEqual(Array.from({ length: 10 }, (_, i) => (i + 10) * 2));
    for (const sent of queryCalls)
      expect(sent.params).toEqual([{ column: "min", value: expect.anything() }]);
    const scanned = queryCalls.length;
    await loadPage(even, request(20), {}, { min: 3 });
    expect(queryCalls.length).toBe(scanned);
    await loadPage(even, request(20), {}, { min: 4 });
    expect(queryCalls.length).toBeGreaterThan(scanned);
  });

  it("pages an unfiltered saved query with one call", async () => {
    size = 50;
    const page = await loadPage(queryForm(""), request(40), {}, {});
    expect(page.total).toBe(50);
    expect(page.rows).toHaveLength(10);
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]).toMatchObject({ offset: 40, limit: 10 });
  });
});

describe("first record and row filter checks", () => {
  it("opens the first row that passes the filter and stops scanning there", async () => {
    size = 30_000;
    await expect(firstRecordId(form(""))).resolves.toBe(0);
    expect(reads).toEqual([{ offset: 0, limit: 1 }]);
    reads.length = 0;
    const later = form("record.n > app.min");
    await expect(firstRecordId(later, {}, { app: { min: 1234 } })).resolves.toBe(1235);
    expect(reads.map((r) => r.offset)).toEqual([0, 500, 1000]);
    await expect(firstRecordId(later, {}, { app: { min: 29_990 } })).resolves.toBe(29_991);
    await expect(firstRecordId(later, {}, { app: { min: 99_999 } })).resolves.toBeNull();
  });

  it("returns the whole first passing row of a query source", async () => {
    size = 10;
    const query = {
      id: "q",
      name: "Numbers",
      source: { kind: "query", queryId: "q1", params: {} },
      filter: "record.n = params.pick",
      controls: [],
    } as unknown as DesignForm;
    await expect(firstRecordId(query, { min: 1 }, { params: { pick: 7 } })).resolves.toEqual({
      n: 7,
    });
    expect(queryCalls[0]).toMatchObject({ offset: 0, limit: 500 });
  });

  it("checks one record against the filter with the list scope", () => {
    const capped = form("record.n < app.max and params.on");
    expect(passesFilter(capped, { n: 3 }, { app: { max: 5 }, params: { on: true } })).toBe(true);
    expect(passesFilter(capped, { n: 7 }, { app: { max: 5 }, params: { on: true } })).toBe(false);
    expect(passesFilter(capped, { n: 3 }, { app: { max: 5 } })).toBe(false);
    expect(passesFilter(form(""), { n: 7 })).toBe(true);
    expect(() => passesFilter(form("record.n <"), { n: 1 })).toThrow();
  });
});
