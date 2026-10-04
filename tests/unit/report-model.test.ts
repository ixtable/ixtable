import { describe, expect, it } from "vitest";
import { clampGeometry } from "../../src/reports/designer/geometry";
import { cellValue, resultRows } from "../../src/reports/data";
import {
  bandEntries,
  contentWidth,
  duplicateReport,
  fieldExpression,
  findComponent,
  isPageBand,
  newComponent,
  newGroup,
  newReport,
  pageDimensions,
  reportProblems,
  withBand,
} from "../../src/reports/model";

describe("report model", () => {
  it("creates a report with A4 defaults and lists bands in print order", () => {
    const report = newReport("Sales");
    expect(pageDimensions(report.page)).toEqual({ width: 595, height: 842 });
    expect(contentWidth(report.page)).toBe(523);
    const outer = newGroup("record.region");
    const inner = newGroup("record.city");
    report.bands.groups = [outer, inner];
    expect(bandEntries(report).map((b) => b.label)).toEqual([
      "Report header",
      "Page header",
      "Group 1 (record.region) header",
      "Group 2 (record.city) header",
      "Detail",
      "Group 2 (record.city) footer",
      "Group 1 (record.region) footer",
      "Page footer",
      "Report footer",
    ]);
    const changed = withBand(report, `groupFooter:${inner.id}`, (b) => ({ ...b, height: 99 }));
    expect(changed.bands.groups[1].footer.height).toBe(99);
    expect(report.bands.groups[1].footer.height).toBe(20);
    expect(withBand(report, "detail", (b) => ({ ...b, keepTogether: true })).bands.detail).toEqual({
      height: 18,
      keepTogether: true,
      components: [],
    });
  });

  it("duplicates with fresh ids for the report, groups, components and table columns", () => {
    const report = newReport("Sales");
    report.bands.groups = [newGroup("record.region")];
    const table = newComponent("table", 523);
    if (table.kind === "table")
      table.columns = [{ id: "col", header: "A", expression: "record.a", width: 1 }];
    report.bands.detail.components = [table];
    const copy = duplicateReport(report, "Sales copy");
    expect(copy.name).toBe("Sales copy");
    expect(copy.id).not.toBe(report.id);
    expect(copy.bands.groups[0].id).not.toBe(report.bands.groups[0].id);
    const copied = copy.bands.detail.components[0];
    expect(copied.id).not.toBe(table.id);
    expect(copied.kind === "table" && copied.columns[0].id).not.toBe("col");
    expect(findComponent(copy, copied.id)?.key).toBe("detail");
  });

  it("builds field expressions and keeps new and moved components in the band", () => {
    expect(fieldExpression("amount")).toBe("record.amount");
    expect(fieldExpression("Unit Price")).toBe("record.[Unit Price]");
    expect(newComponent("staticText", 523, { x: 500, y: 3 })).toMatchObject({
      x: 403,
      y: 3,
      w: 120,
      h: 16,
    });
    expect(clampGeometry({ x: -4.4, y: 50, w: 600, h: 0 }, 523, 30)).toEqual({
      x: 0,
      y: 29,
      w: 523,
      h: 1,
    });
  });

  it("converts query cells to plain values", () => {
    expect(
      [
        { type: "integer", value: "42" },
        { type: "real", value: 1.5 },
        { type: "boolean", value: true },
        { type: "date", value: "2026-01-05" },
        { type: "null" },
      ].map((cell) => cellValue(cell as Parameters<typeof cellValue>[0])),
    ).toEqual([42, 1.5, true, "2026-01-05", null]);
    expect(
      resultRows({
        columns: ["a", "b"],
        rows: [[{ type: "integer", value: 1 }, { type: "null" }]],
      }),
    ).toEqual([{ a: 1, b: null }]);
  });
});

describe("reportProblems", () => {
  it("flags tables in page headers and footers only", () => {
    const report = newReport("R");
    const table = newComponent("table", 523);
    report.bands.pageFooter.components.push(table);
    report.bands.detail.components.push(newComponent("table", 523));
    expect(reportProblems(report)).toEqual([
      `Page footer component ${table.id}: tables are not supported in page headers or footers`,
    ]);
    expect(isPageBand("pageHeader")).toBe(true);
    expect(isPageBand("detail")).toBe(false);
  });
});
