import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignForm } from "../../src/design/schema";
import type { DocumentConfig } from "../../src/lib/types";

const reads: Array<{ offset: number; limit: number }> = [];
let size = 0;
vi.mock("../../src/lib/api", () => ({
  call: vi.fn(),
  inspectTable: vi.fn(),
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

const { invalidateRuntimeCache, loadPage } = await import("../../src/runtime/data");

const form = (filter: string) =>
  ({
    id: "f",
    name: "Numbers",
    source: { kind: "table", table: "numbers" },
    filter,
    controls: [],
  }) as unknown as DesignForm;
const config = {} as DocumentConfig;
const request = (offset: number) => ({ offset, limit: 10, sorts: [], filters: [] });

beforeEach(() => {
  reads.length = 0;
  invalidateRuntimeCache();
});

describe("filtered table paging", () => {
  it("scans once and pages through sparse matches without rescanning", async () => {
    size = 30_000;
    const sparse = form("record.n % 1000 = 0");
    const first = await loadPage(config, sparse, request(0));
    expect(first.rows.map((r) => r.n)).toEqual(Array.from({ length: 10 }, (_, i) => i * 1000));
    expect(first.total).toBe(30);
    expect(first.truncated).toBe(false);
    const scanned = reads.length;
    const third = await loadPage(config, sparse, request(20));
    expect(third.rows.map((r) => r.n)).toEqual(
      Array.from({ length: 10 }, (_, i) => (i + 20) * 1000),
    );
    expect(reads.length).toBe(scanned);
  });

  it("rescans when the filter inputs change and after a cache invalidation", async () => {
    size = 2000;
    const filtered = form("record.n < app.max");
    expect((await loadPage(config, filtered, request(0), { app: { max: 5 } })).total).toBe(5);
    const scanned = reads.length;
    expect((await loadPage(config, filtered, request(0), { app: { max: 50 } })).total).toBe(50);
    expect(reads.length).toBeGreaterThan(scanned);
    const again = reads.length;
    invalidateRuntimeCache();
    await loadPage(config, filtered, request(0), { app: { max: 50 } });
    expect(reads.length).toBeGreaterThan(again);
  });

  it("marks a page truncated when the table is larger than the scan limit", async () => {
    size = 60_000;
    const page = await loadPage(config, form("record.n >= 49990"), request(0));
    expect(page.truncated).toBe(true);
    expect(page.total).toBe(10);
  });
});
