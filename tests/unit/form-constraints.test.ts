import { describe, expect, it } from "vitest";
import { controlConstraints } from "../../src/design/constraints";
import { CONTROL_KINDS } from "../../src/design/schema";
import { defaultGridLayout, resizePlacement } from "../../src/grid/engine";

describe("form control resize limits", () => {
  it("gives each kind a minimum width and caps every kind at the grid width", () => {
    expect(controlConstraints("boolean", 12)).toEqual({ minColumnSpan: 1, maxColumnSpan: 12 });
    expect(controlConstraints("text", 12).minColumnSpan).toBe(2);
    expect(controlConstraints("section", 12).minColumnSpan).toBe(4);
    expect(controlConstraints("tabs", 12).minColumnSpan).toBe(4);
    expect(controlConstraints("relatedList", 12).minColumnSpan).toBe(6);
    for (const kind of CONTROL_KINDS) {
      const limits = controlConstraints(kind, 12);
      expect(limits.maxColumnSpan).toBe(12);
      expect(limits.minColumnSpan).toBeGreaterThanOrEqual(1);
      expect(limits.minColumnSpan).toBeLessThanOrEqual(12);
    }
  });

  it("scales minimums with the column count and never exceeds a narrow grid", () => {
    expect(controlConstraints("relatedList", 4)).toEqual({ minColumnSpan: 2, maxColumnSpan: 4 });
    expect(controlConstraints("boolean", 4).minColumnSpan).toBe(1);
    expect(controlConstraints("relatedList", 1)).toEqual({ minColumnSpan: 1, maxColumnSpan: 1 });
    expect(controlConstraints("tabs", 0)).toEqual({ minColumnSpan: 1, maxColumnSpan: 1 });
  });

  it("stops resizing at the limit", () => {
    const layout = defaultGridLayout();
    const placement = { column: 1, row: 1, columnSpan: 6, rowSpan: 1, region: null };
    const list = controlConstraints("relatedList", 12);
    expect(resizePlacement(placement, { columns: -5 }, layout, list).columnSpan).toBe(6);
    expect(resizePlacement(placement, { columns: 20 }, layout, list).columnSpan).toBe(12);
    const flag = controlConstraints("boolean", 12);
    expect(resizePlacement(placement, { columns: -10 }, layout, flag).columnSpan).toBe(1);
  });
});
