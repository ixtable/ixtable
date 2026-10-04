import { describe, expect, it } from "vitest";
import {
  formatLogical,
  logicalOf,
  modeLabel,
  parseLogical,
  valueFromText,
} from "../../src/schema/logical";

describe("logical types", () => {
  it("parses and formats decimal precision and scale", () => {
    expect(parseLogical("decimal(12, 3)")).toEqual({ base: "decimal", precision: 12, scale: 3 });
    expect(formatLogical({ base: "decimal", precision: 8, scale: 1 })).toBe("decimal(8,1)");
    expect(formatLogical({ base: "date", precision: 10, scale: 2 })).toBe("date");
  });

  it("falls back to SQLite affinity when a backend sends no logical type", () => {
    expect(logicalOf({ declaredType: "BIGINT" })).toBe("integer");
    expect(logicalOf({ declaredType: "DOUBLE" })).toBe("real");
    expect(logicalOf({ declaredType: "TIME TEXT", logicalType: "time" })).toBe("time");
  });

  it("turns typed text into values and reports values that do not fit", () => {
    expect(valueFromText("42", "qty", "integer")).toEqual({ type: "integer", value: 42 });
    expect(valueFromText("12.50", "price", "decimal(10,2)")).toEqual({
      type: "decimal",
      value: "12.50",
    });
    expect(valueFromText("yes", "done", "boolean")).toEqual({ type: "boolean", value: true });
    expect(valueFromText("NULL", "any", "text")).toEqual({ type: "null" });
    expect(() => valueFromText("4.5", "qty", "integer")).toThrow("qty requires an integer");
    expect(() => valueFromText("abc", "price", "decimal(10,2)")).toThrow("decimal number");
    expect(() => valueFromText("9007199254740993", "id", "integer")).toThrow("safe integer");
  });

  it("speaks store capabilities rather than SQLite terms", () => {
    expect(modeLabel("inPlace")).toBe("Changes in place");
    expect(modeLabel("rebuild")).toBe("Requires table rebuild");
  });
});
