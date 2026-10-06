import { describe, expect, it } from "vitest";
import { newReport } from "../../src/reports/model";
import { parseParameter, reportParameters } from "../../src/reports/parameters";
import type { SavedQuery } from "../../src/query/types";

const query = (id: string, parameters: SavedQuery["parameters"]): SavedQuery => ({
  id,
  name: id,
  sql: "SELECT 1",
  parameters,
});

describe("report parameters", () => {
  it("collects dataset then table query parameters with report defaults first", () => {
    const report = newReport("R");
    report.datasetQueryId = "ds";
    report.params = { region: "West" };
    report.bands.detail.components = [
      { id: "t", kind: "table", queryId: "lines", columns: [], x: 0, y: 0, w: 100, h: 20 },
    ];
    const params = reportParameters(report, [
      query("ds", [
        { name: "region", logicalType: "text", defaultValue: "East" },
        { name: "since", logicalType: "date", defaultValue: "2026-01-01" },
      ]),
      query("lines", [
        { name: "region", logicalType: "integer" },
        { name: "limit", logicalType: "integer", required: true },
      ]),
      query("unused", [{ name: "other", logicalType: "text" }]),
    ]);
    expect(params).toEqual([
      { name: "region", logicalType: "text", defaultValue: "West" },
      { name: "since", logicalType: "date", defaultValue: "2026-01-01" },
      { name: "limit", logicalType: "integer", required: true, defaultValue: undefined },
    ]);
    expect(reportParameters(newReport("Plain"), [])).toEqual([]);
  });

  it("parses prompt values by logical type", () => {
    const p = (logicalType: string, required = false) => ({ name: "x", logicalType, required });
    expect(parseParameter(p("integer"), " 42 ")).toEqual({ value: 42 });
    expect(parseParameter(p("integer"), "4.5")).toEqual({ error: "x must be a whole number." });
    expect(parseParameter(p("number"), "4.5")).toEqual({ value: 4.5 });
    expect(parseParameter(p("number"), "abc")).toEqual({ error: "x must be a number." });
    expect(parseParameter(p("text"), "")).toEqual({ value: null });
    expect(parseParameter(p("text", true), " ")).toEqual({ error: "Enter a value for x." });
    expect(parseParameter(p("date"), "2026-03-01")).toEqual({ value: "2026-03-01" });
    expect(parseParameter(p("boolean"), false)).toEqual({ value: false });
  });
});
