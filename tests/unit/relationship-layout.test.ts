import { describe, expect, it } from "vitest";
import { defaultLayout } from "../../src/data/layout";

const table = (fields: number) => ({
  columns: Array.from({ length: fields }, () => ({})) as never,
});

describe("relationship diagram default layout", () => {
  it("places three tables per row with the original spacing for small tables", () => {
    expect(defaultLayout([table(2), table(3), table(4), table(1)])).toEqual([
      { x: 30, y: 25 },
      { x: 330, y: 25 },
      { x: 630, y: 25 },
      { x: 30, y: 215 },
    ]);
  });

  it("starts the next row below the tallest table of the row above", () => {
    const [, , , next] = defaultLayout([table(3), table(10), table(2), table(1)]);
    expect(next).toEqual({ x: 30, y: 25 + 280 + 50 });
  });

  it("returns no positions for no tables", () => {
    expect(defaultLayout([])).toEqual([]);
  });
});

describe("relationship diagram layout by foreign-key dependency", () => {
  const schema = (name: string, fields: number, parents: string[] = []) => ({
    name,
    columns: Array.from({ length: fields }, () => ({})) as never,
    foreignKeys: parents.map((targetTable) => ({ targetTable })) as never,
  });
  const tables = [
    schema("customers", 3),
    schema("order_items", 4, ["orders"]),
    schema("orders", 5, ["customers"]),
    schema("shipments", 4, ["orders"]),
  ];

  it("puts referenced tables left of the tables that reference them", () => {
    const [customers, items, orders, shipments] = defaultLayout(tables);
    expect(customers).toEqual({ x: 30, y: 25 });
    expect(orders).toEqual({ x: 330, y: 25 });
    expect(items.x).toBe(630);
    expect(shipments.x).toBe(630);
    expect(shipments.y).toBeGreaterThan(items.y);
  });

  it("draws every edge between neighbouring columns, so none runs behind another table", () => {
    const positions = defaultLayout(tables);
    const index = new Map(tables.map((t, i) => [t.name, i]));
    for (const [child, table] of tables.entries())
      for (const key of table.foreignKeys as unknown as { targetTable: string }[]) {
        const parent = index.get(key.targetTable) ?? -1;
        expect(positions[child].x - positions[parent].x).toBe(300);
      }
  });

  it("places unrelated tables in rows below the related ones and survives cycles", () => {
    const positions = defaultLayout([
      schema("a", 2, ["b"]),
      schema("b", 2, ["a"]),
      schema("self", 2, ["self"]),
      schema("lonely", 2),
    ]);
    expect(positions).toHaveLength(4);
    expect(positions[0].x).not.toBe(positions[1].x);
    expect(positions[2]).toEqual({ x: 30, y: positions[3].y });
    expect(positions[3]).toEqual({ x: 330, y: 25 + 140 + 50 });
  });
});
