import { describe, expect, it } from "vitest";
import { addGeneratedApp } from "../../src/design/generateApp";
import { type DesignSchema, flattenNavigation, formTable, newForm } from "../../src/design/schema";
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
  columns: [col("id", "INTEGER", { primaryKeyPosition: 1 }), col("name", "TEXT")],
  foreignKeys: [],
  withoutRowid: false,
};
const orders: TableSchema = {
  name: "orders",
  columns: [
    col("id", "INTEGER", { primaryKeyPosition: 1 }),
    col("customer_id", "INTEGER"),
    col("note", "TEXT"),
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
const empty = (): DesignSchema => ({ version: 3, forms: [], navigation: [], startPage: null });

describe("generate app from tables", () => {
  it("adds list and detail forms and a page per table, linking lookups and related lists", () => {
    const design = addGeneratedApp(empty(), [customers, orders]);
    expect(design.forms.map((f) => f.name)).toEqual([
      "Customers list",
      "Customers",
      "Orders list",
      "Orders",
    ]);
    expect(design.navigation.map((n) => n.label)).toEqual(["Customers", "Orders"]);
    expect(design.startPage).toBe(design.navigation[0].id);
    const customerForm = design.forms.find((f) => f.name === "Customers");
    const orderForm = design.forms.find((f) => f.name === "Orders");
    const related = customerForm?.controls.find((c) => c.kind === "relatedList");
    expect(related?.related).toMatchObject({ table: "orders", formId: orderForm?.id });
    expect(orderForm?.controls.find((c) => c.kind === "relationship")?.relationship).toEqual({
      table: "customers",
      valueColumn: "id",
      displayColumn: "name",
    });
  });

  it("is idempotent: running it again changes nothing", () => {
    const once = addGeneratedApp(empty(), [customers, orders]);
    const twice = addGeneratedApp(once, [customers, orders]);
    expect(twice).toBe(once);
    expect(JSON.parse(JSON.stringify(twice))).toEqual(JSON.parse(JSON.stringify(once)));
  });

  it("adds only what is missing, keeping hand-built forms and pages", () => {
    const manual = newForm("My customers", { kind: "table", table: "customers" });
    const base: DesignSchema = { ...empty(), forms: [manual] };
    const design = addGeneratedApp(base, [customers, orders]);
    expect(design.forms.filter((f) => formTable(f) === "customers")).toEqual([manual]);
    expect(design.forms.filter((f) => formTable(f) === "orders")).toHaveLength(2);
    const pages = flattenNavigation(design.navigation);
    expect(pages.map((p) => p.label)).toEqual(["My customers", "Orders"]);
    expect(pages[0].targetId).toBe(manual.id);
    const later: TableSchema = { ...customers, name: "regions" };
    const next = addGeneratedApp(design, [customers, orders, later]);
    expect(next.forms.slice(0, design.forms.length)).toEqual(design.forms);
    expect(next.forms.length).toBe(design.forms.length + 2);
    expect(next.navigation.map((n) => n.label)).toEqual(["My customers", "Orders", "Regions"]);
  });

  it("limits generation to the named tables", () => {
    const design = addGeneratedApp(empty(), [customers, orders], ["orders"]);
    expect(design.forms.map((f) => f.name)).toEqual(["Orders list", "Orders"]);
    expect(design.navigation.map((n) => n.label)).toEqual(["Orders"]);
  });

  it("counts a table navigation item as a page for that table", () => {
    const base: DesignSchema = {
      ...empty(),
      navigation: [{ id: "t", label: "Raw", kind: "table", targetId: "customers", children: [] }],
    };
    const design = addGeneratedApp(base, [customers]);
    expect(design.navigation).toHaveLength(1);
    expect(design.forms).toHaveLength(2);
  });
});
