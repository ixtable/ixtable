import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignControl } from "../../src/design/schema";
import type { TableSchema } from "../../src/lib/types";

const calls = vi.hoisted(() => [] as Array<{ command: string; args: Record<string, unknown> }>);
const schemas = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "inspect_table") return schemas.get(String(args.table));
    if (command === "execute_parameterized_query" && String(args.sql).includes("lookup_key0"))
      return {
        columns: ["lookup_key0", "lookup_key1", "lookup_display"],
        rows: [
          [
            { type: "integer", value: 17 },
            { type: "integer", value: 2 },
            { type: "text", value: "Bolts at Depot" },
          ],
        ],
      };
    if (command === "execute_parameterized_query") {
      const params = args.params as Array<{ value: { value: unknown } }>;
      const names: Record<number, string> = { 1: "Acme", 2: "Globex" };
      return {
        columns: ["lookup_key", "lookup_display"],
        rows: params
          .map((p) => Number(p.value.value))
          .filter((id) => names[id])
          .map((id) => [
            { type: "integer", value: id },
            { type: "text", value: names[id] },
          ]),
      };
    }
    throw new Error(`unexpected ${command}`);
  },
}));

const { columnLookups, guessDisplayColumn, lookupKey, lookupLabels } = await import(
  "../../src/runtime/lookups"
);

const column = (name: string, declaredType: string, primaryKeyPosition = 0) => ({
  name,
  declaredType,
  primaryKeyPosition,
  nullable: true,
});
const table = (name: string, columns: ReturnType<typeof column>[], fks = []): TableSchema =>
  ({ name, columns, foreignKeys: fks, withoutRowid: false }) as unknown as TableSchema;

beforeEach(() => {
  calls.length = 0;
  schemas.set(
    "customers",
    table("customers", [
      column("id", "INTEGER", 1),
      column("code", "TEXT"),
      column("Name", "TEXT"),
    ]),
  );
  schemas.set("regions", table("regions", [column("id", "INTEGER", 1), column("code", "TEXT")]));
  schemas.set(
    "orders",
    table(
      "orders",
      [
        column("id", "INTEGER", 1),
        column("customer_id", "INTEGER"),
        column("region_id", "INTEGER"),
      ],
      [
        { fromColumns: ["customer_id"], targetTable: "customers", targetColumns: ["id"] },
        { fromColumns: ["region_id"], targetTable: "regions", targetColumns: ["id"] },
      ] as never,
    ),
  );
});

describe("runtime relationship lookups", () => {
  it("guesses a text column named name, title, or label", () => {
    expect(guessDisplayColumn(schemas.get("customers") as TableSchema)).toBe("Name");
    expect(guessDisplayColumn(schemas.get("regions") as TableSchema)).toBeNull();
  });

  it("prefers the relationship control, falls back to foreign keys, and skips id-only targets", async () => {
    const control = {
      kind: "relationship",
      relationship: { table: "customers", valueColumn: "id", displayColumn: "code" },
    } as DesignControl;
    expect(
      await columnLookups("orders", ["customer_id", "region_id", "id"], (c) =>
        c === "customer_id" ? control : undefined,
      ),
    ).toEqual({ customer_id: { table: "customers", valueColumn: "id", displayColumn: "code" } });
    expect(await columnLookups("orders", ["customer_id", "region_id"], () => undefined)).toEqual({
      customer_id: { table: "customers", valueColumn: "id", displayColumn: "Name" },
    });
  });

  it("reads labels with one bound IN query per lookup and caches them", async () => {
    const lookups = {
      customer_id: { table: "customers", valueColumn: "id", displayColumn: "Name" },
    };
    const rows = [{ customer_id: 1 }, { customer_id: 2 }, { customer_id: 1 }, { customer_id: 9 }];
    const labels = await lookupLabels(lookups, rows);
    expect([...labels.customer_id.entries()]).toEqual([
      ["1", "Acme"],
      ["2", "Globex"],
    ]);
    const queries = calls.filter((c) => c.command === "execute_parameterized_query");
    expect(queries).toHaveLength(1);
    expect(queries[0].args.sql).toBe(
      'SELECT "id" AS lookup_key, "Name" AS lookup_display FROM "customers" WHERE "id" IN ($k0, $k1, $k2)',
    );
    expect(queries[0].args.params).toEqual([
      { column: "k0", value: { type: "integer", value: 1 } },
      { column: "k1", value: { type: "integer", value: 2 } },
      { column: "k2", value: { type: "integer", value: 9 } },
    ]);
    await lookupLabels(lookups, rows);
    expect(calls.filter((c) => c.command === "execute_parameterized_query")).toHaveLength(1);
  });

  it("labels a multi-column relationship by every key column", async () => {
    const relationship = {
      table: "thresholds",
      valueColumn: "product_id",
      displayColumn: "label",
      keys: [
        { column: "product_id", target: "product_id" },
        { column: "location_id", target: "location_id" },
      ],
    };
    const control = { kind: "relationship", relationship } as DesignControl;
    expect(await columnLookups("orders", ["product_id"], () => control)).toEqual({
      product_id: relationship,
    });
    const rows = [
      { product_id: 17, location_id: 2 },
      { product_id: 17, location_id: null },
    ];
    const labels = await lookupLabels({ product_id: relationship }, rows);
    const queries = calls.filter((c) => c.command === "execute_parameterized_query");
    expect(queries[0].args.sql).toBe(
      'SELECT "product_id" AS lookup_key0, "location_id" AS lookup_key1, "label" AS lookup_display FROM "thresholds" WHERE ("product_id" = $k0_0 AND "location_id" = $k0_1)',
    );
    expect(labels.product_id.get(lookupKey(relationship, "product_id", rows[0]) ?? "")).toBe(
      "Bolts at Depot",
    );
    expect(lookupKey(relationship, "product_id", rows[1])).toBeUndefined();
  });
});
