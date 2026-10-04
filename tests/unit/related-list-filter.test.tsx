import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesignControl } from "../../src/design/schema";
import type { BodyContext } from "../../src/runtime/FormBody";

const readTablePage = vi.fn();
const column = (name: string, primaryKeyPosition = 0) => ({
  name,
  declaredType: "INTEGER",
  nullable: true,
  defaultValue: null,
  primaryKeyPosition,
  generated: false,
});
vi.mock("../../src/lib/api", () => ({
  call: vi.fn(),
  asTauriError: (error: unknown) => error,
  listDatabaseObjects: async () => [],
  inspectTable: async () => ({
    name: "counts",
    columns: [column("id", 1), column("product_id"), column("location_id"), column("counted")],
    foreignKeys: [],
    withoutRowid: false,
  }),
  readTablePage: (...args: unknown[]) => readTablePage(...args),
}));
vi.mock("../../src/lib/config-store", () => ({ useDocumentConfig: () => ({ config: {} }) }));
vi.mock("../../src/runtime/FormRenderer", () => ({ FormRenderer: () => null }));

const { RelatedRecords } = await import("../../src/runtime/RelatedList");

const int = (value: number) => ({ type: "integer", value });
const page = (rows: number[][]) => ({
  columns: ["id", "product_id", "location_id", "counted"].map((name) => column(name)),
  rows: rows.map((row) => row.map(int)),
  identities: rows.map((row) => [int(row[0])]),
  total: rows.length,
  offset: 0,
  limit: 500,
});

describe("related list over a multi-column key", () => {
  it("matches every key column, then applies the row filter", async () => {
    readTablePage.mockImplementation(async (_table: string, options: { offset?: number }) =>
      options.offset
        ? page([])
        : page([
            [1, 1, 2, 4],
            [2, 1, 2, 7],
          ]),
    );
    const control = {
      id: "rl",
      kind: "relatedList",
      label: "Counts",
      related: {
        table: "counts",
        foreignKey: "product_id",
        parentColumn: "product_id",
        keys: [
          { column: "product_id", target: "product_id" },
          { column: "location_id", target: "location_id" },
        ],
        columns: ["id", "counted"],
        filter: "record.counted > parent.minimum",
      },
    } as unknown as DesignControl;
    const ctx = {
      scope: { record: { product_id: 1, location_id: 2, minimum: 5 }, form: {}, app: {} },
      identity: [int(1)],
    } as unknown as BodyContext;
    render(<RelatedRecords ctx={ctx} control={control} />);
    expect(await screen.findByRole("cell", { name: "7" }, { timeout: 2000 })).toBeVisible();
    expect(screen.queryByRole("cell", { name: "4" })).toBeNull();
    const [, options] = readTablePage.mock.calls[0] as [string, { filters: unknown[] }];
    expect(options.filters).toEqual([
      { column: "product_id", operator: "eq", value: int(1) },
      { column: "location_id", operator: "eq", value: int(2) },
    ]);
  });
});
