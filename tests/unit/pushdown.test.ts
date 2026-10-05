import { describe, expect, it } from "vitest";
import { evaluateBoolean, parse } from "../../src/expr";
import type { DbColumn } from "../../src/lib/types";
import { pushdown } from "../../src/runtime/pushdown";

const column = (name: string, logicalType: string): DbColumn =>
  ({ name, declaredType: "", logicalType, nullable: true, primaryKeyPosition: 0 }) as DbColumn;
const columns = [
  column("amount", "real"),
  column("qty", "integer"),
  column("status", "text"),
  column("price", "decimal(10,2)"),
  column("active", "boolean"),
  column("due", "date"),
];
const scope = { app: { min: 10, statuses: ["won", "lost"] }, params: {}, form: {}, parent: null };
const split = (src: string) => pushdown(parse(src), scope, columns);
const restOf = (src: string) => {
  const rest = split(src).rest;
  return rest && src.slice(rest.start, rest.end);
};

describe("row filter pushdown", () => {
  it("pushes numeric comparisons with constants, either side, values computed in TypeScript", () => {
    expect(split("record.amount >= app.min * 2").filters).toEqual([
      { column: "amount", operator: "gte", value: { type: "integer", value: 20 } },
    ]);
    expect(split("100.5 > record.qty").filters).toEqual([
      { column: "qty", operator: "lt", value: { type: "real", value: 100.5 } },
    ]);
    expect(split("record.amount >= 1").rest).toBeNull();
  });

  it("pushes text equality, null checks, in lists, and between", () => {
    expect(split('record.status = "won" and record.due is not null').filters).toEqual([
      { column: "status", operator: "eq", value: { type: "text", value: "won" } },
      { column: "due", operator: "is_not_null" },
    ]);
    expect(split("record.status in (app.statuses)").filters).toEqual([
      {
        column: "status",
        operator: "in",
        values: [
          { type: "text", value: "won" },
          { type: "text", value: "lost" },
        ],
      },
    ]);
    expect(split("record.qty between 1 and 5").filters).toEqual([
      { column: "qty", operator: "gte", value: { type: "integer", value: 1 } },
      { column: "qty", operator: "lte", value: { type: "integer", value: 5 } },
    ]);
  });

  it("keeps what SQL could evaluate differently in the residual expression", () => {
    for (const src of [
      "record.price > 10",
      "record.active = true",
      'record.status < "m"',
      'record.status = "2026-01-31"',
      'record.amount > "10"',
      "record.amount > null",
      "record.amount > record.qty",
      "record.amount % 2 = 0",
      "record.qty not in (1, 2)",
      "record.qty in (1, null)",
      "record.qty not between 1 and 5",
      "record.missing = 1",
      "record.amount > 1 or record.qty > 1",
      "not (record.amount > 1)",
      "record.amount > app.nothing.deeper",
    ]) {
      expect(split(src), src).toEqual({ filters: [], rest: parse(src) });
    }
  });

  it("splits a conjunction into pushed filters and a residual that keeps the same rows", () => {
    const src = 'record.amount >= 5 and record.qty % 2 = 0 and record.status = "won"';
    const { filters, rest } = split(src);
    expect(filters.map((f) => f.column)).toEqual(["amount", "status"]);
    expect(restOf(src)).toBe("record.qty % 2 = 0");
    const passes = (test: () => boolean) => {
      try {
        return test();
      } catch {
        return false;
      }
    };
    for (const amount of [4, 5, null])
      for (const qty of [2, 3, null])
        for (const status of ["won", "lost", null]) {
          const record = { amount, qty, status };
          const whole = passes(() => evaluateBoolean(src, { ...scope, record }));
          const pushed = amount !== null && amount >= 5 && status === "won";
          const residual = passes(() => evaluateBoolean(rest!, { ...scope, record }));
          expect(pushed && residual, JSON.stringify(record)).toBe(whole);
        }
  });
});
