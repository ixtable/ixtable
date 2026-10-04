import { describe, expect, it } from "vitest";
import { generateCrudForms, humanize, kindForColumn } from "../../src/design/generate";
import { isInputKind } from "../../src/design/schema";
import type { DbColumn, TableSchema } from "../../src/lib/types";

const col = (name: string, declaredType: string, extra: Partial<DbColumn> = {}): DbColumn => ({
  name,
  declaredType,
  nullable: true,
  defaultValue: null,
  primaryKeyPosition: 0,
  generated: false,
  ...extra,
});

const customers: TableSchema = {
  name: "customers",
  columns: [
    col("id", "INTEGER", { primaryKeyPosition: 1, nullable: false }),
    col("name", "TEXT", { nullable: false }),
  ],
  foreignKeys: [],
  withoutRowid: false,
};
const orders: TableSchema = {
  name: "orders",
  columns: [
    col("id", "INTEGER", { primaryKeyPosition: 1, nullable: false }),
    col("customer_id", "INTEGER", { nullable: false }),
    col("placed_on", "DATE"),
    col("total", "DECIMAL(10,2)"),
    col("paid", "BOOLEAN", { nullable: false, defaultValue: "0" }),
    col("photo", "BLOB"),
  ],
  foreignKeys: [
    {
      id: 0,
      fromColumns: ["customer_id"],
      targetTable: "customers",
      targetColumns: ["id"],
      onUpdate: "",
      onDelete: "",
    },
  ],
  withoutRowid: false,
};
const items: TableSchema = {
  name: "order_items",
  columns: [
    col("id", "INTEGER", { primaryKeyPosition: 1 }),
    col("order_id", "INTEGER"),
    col("product", "TEXT"),
    col("qty", "INT"),
  ],
  foreignKeys: [
    {
      id: 0,
      fromColumns: ["order_id"],
      targetTable: "orders",
      targetColumns: ["id"],
      onUpdate: "",
      onDelete: "",
    },
  ],
  withoutRowid: false,
};

const fk = (fromColumns: string[], targetTable: string, targetColumns: string[]) => ({
  id: 0,
  fromColumns,
  targetTable,
  targetColumns,
  onUpdate: "",
  onDelete: "",
});
const thresholds: TableSchema = {
  name: "reorder_thresholds",
  columns: [
    col("product_id", "INTEGER", { primaryKeyPosition: 1, nullable: false }),
    col("location_id", "INTEGER", { primaryKeyPosition: 2, nullable: false }),
    col("label", "TEXT"),
  ],
  foreignKeys: [],
  withoutRowid: false,
};
const counts: TableSchema = {
  name: "stock_counts",
  columns: [
    col("id", "INTEGER", { primaryKeyPosition: 1 }),
    col("product_id", "INTEGER", { nullable: false }),
    col("location_id", "INTEGER", { nullable: false }),
    col("counted", "INTEGER"),
  ],
  foreignKeys: [
    fk(["product_id", "location_id"], "reorder_thresholds", ["product_id", "location_id"]),
  ],
  withoutRowid: false,
};

describe("generated CRUD forms", () => {
  it("maps declared types to control kinds", () => {
    expect(kindForColumn(col("a", "VARCHAR(20)"))).toBe("text");
    expect(kindForColumn(col("a", "BIGINT"))).toBe("number");
    expect(kindForColumn(col("a", "NUMERIC"))).toBe("decimal");
    expect(kindForColumn(col("a", "TIMESTAMP"))).toBe("datetime");
    expect(kindForColumn(col("a", "TIME"))).toBe("time");
    expect(kindForColumn(col("a", "BLOB"))).toBeNull();
    expect(humanize("order_items")).toBe("Order items");
  });

  it("builds a list form and a detail form from the same primitives", () => {
    const { list, detail, navigation } = generateCrudForms(orders, {
      targets: { customers },
      children: [items],
    });
    expect(list.modes).toEqual(["list"]);
    expect(list.detailFormId).toBe(detail.id);
    expect(list.listColumns).toEqual(["id", "customer_id", "placed_on", "total", "paid"]);
    expect(detail.modes).toEqual(["detail", "create", "edit"]);
    expect(detail.source).toEqual({ kind: "table", table: "orders" });
    expect(navigation).toMatchObject({ kind: "form", targetId: list.id, label: "Orders" });

    const byColumn = Object.fromEntries(
      detail.controls.map((c) => [c.binding?.column ?? c.kind, c]),
    );
    expect(byColumn.id).toMatchObject({
      kind: "number",
      readOnly: true,
      validation: { required: false },
    });
    expect(byColumn.customer_id).toMatchObject({
      kind: "relationship",
      label: "Customer",
      validation: { required: true },
      relationship: { table: "customers", valueColumn: "id", displayColumn: "name" },
    });
    expect(byColumn.placed_on.kind).toBe("date");
    expect(byColumn.total.kind).toBe("decimal");
    expect(byColumn.paid).toMatchObject({ kind: "boolean", validation: { required: false } });
    expect(byColumn.photo).toBeUndefined();
    expect(byColumn.relatedList).toMatchObject({
      label: "Order items",
      related: {
        table: "order_items",
        foreignKey: "order_id",
        parentColumn: "id",
        columns: ["id", "product", "qty"],
      },
    });
    const cells = detail.controls.filter((c) => isInputKind(c.kind)).map((c) => c.placement);
    expect(cells.slice(0, 3).map((p) => [p.column, p.row])).toEqual([
      [1, 1],
      [7, 1],
      [1, 2],
    ]);
  });

  it("prefers the logical type inspect_table reports over the declared type", () => {
    expect(kindForColumn(col("a", "character varying", { logicalType: "text" }))).toBe("text");
    expect(kindForColumn(col("a", "double precision", { logicalType: "real" }))).toBe("decimal");
    expect(kindForColumn(col("a", "numeric(10,2)", { logicalType: "decimal(10,2)" }))).toBe(
      "decimal",
    );
    expect(
      kindForColumn(col("a", "timestamp without time zone", { logicalType: "timestamp" })),
    ).toBe("datetime");
    expect(kindForColumn(col("a", "time without time zone", { logicalType: "time" }))).toBe("time");
    expect(kindForColumn(col("a", "point", { logicalType: "integer" }))).toBe("number");
    expect(kindForColumn(col("a", "bytea", { logicalType: "blob" }))).toBeNull();
    expect(kindForColumn(col("a", "uuid", { logicalType: "uuid" }))).toBe("text");
    expect(kindForColumn(col("a", "INTEGER"))).toBe("number");
  });

  it("treats a PostgreSQL identity key as automatic", () => {
    const pg = (declaredType: string, extra: Partial<DbColumn> = {}): TableSchema => ({
      name: "t",
      columns: [
        col("id", declaredType, { primaryKeyPosition: 1, nullable: false, ...extra }),
        col("name", "text", { logicalType: "text" }),
      ],
      foreignKeys: [],
      withoutRowid: false,
    });
    const idControl = (schema: TableSchema) =>
      generateCrudForms(schema).detail.controls.find((c) => c.binding?.column === "id");
    expect(idControl(pg("bigint", { logicalType: "integer" }))).toMatchObject({
      readOnly: true,
      validation: { required: false },
    });
    expect(idControl(pg("text", { logicalType: "text" }))?.readOnly).toBeUndefined();
    expect(
      idControl(pg("bigint", { logicalType: "integer", defaultValue: "42" }))?.readOnly,
    ).toBeUndefined();
  });

  it("generates one selector that writes every column of a multi-column key", () => {
    const { detail } = generateCrudForms(counts, { targets: { reorder_thresholds: thresholds } });
    const selectors = detail.controls.filter((c) => c.kind === "relationship");
    expect(selectors).toHaveLength(1);
    expect(selectors[0]).toMatchObject({
      binding: { column: "product_id" },
      label: "Reorder threshold",
      validation: { required: true },
      relationship: {
        table: "reorder_thresholds",
        valueColumn: "product_id",
        displayColumn: "label",
        keys: [
          { column: "product_id", target: "product_id" },
          { column: "location_id", target: "location_id" },
        ],
      },
    });
    expect(detail.controls.some((c) => c.binding?.column === "location_id")).toBe(false);
  });

  it("generates a related list that matches on every key column", () => {
    const { detail } = generateCrudForms(thresholds, { children: [counts] });
    expect(detail.controls.find((c) => c.kind === "relatedList")?.related).toEqual({
      table: "stock_counts",
      foreignKey: "product_id",
      parentColumn: "product_id",
      keys: [
        { column: "product_id", target: "product_id" },
        { column: "location_id", target: "location_id" },
      ],
      columns: ["id", "counted"],
      formId: null,
    });
  });

  it("keeps single-column relationships in their original shape", () => {
    const { detail } = generateCrudForms(orders, { targets: { customers }, children: [items] });
    for (const control of detail.controls) {
      expect(control.relationship?.keys).toBeUndefined();
      expect(control.related?.keys).toBeUndefined();
    }
  });

  it("falls back to the key column when the lookup table is unknown", () => {
    const { detail } = generateCrudForms(orders);
    expect(
      detail.controls.find((c) => c.kind === "relationship")?.relationship?.displayColumn,
    ).toBe("id");
  });
});
