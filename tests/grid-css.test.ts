import { layoutStyle, placementStyle, trackCss, type GridLayout } from "../src/design/schema";

const fixture: GridLayout = {
  columns: [
    { kind: "fr", value: 1 },
    { kind: "fixed", value: 200, min: 120, max: 320 },
    { kind: "content" },
  ],
  rows: [{ kind: "fixed", value: 48 }],
  columnGap: 8,
  rowGap: 12,
  padding: 16,
  justifyItems: "stretch",
  alignItems: "start",
  namedRegions: [],
  breakpoints: [],
};

describe("shared CSS Grid renderer", () => {
  it("maps tracks without storing raw CSS in the schema", () => {
    expect(trackCss({ kind: "fr", value: 1 })).toBe("1fr");
    expect(trackCss({ kind: "content" })).toBe("max-content");
    expect(trackCss({ kind: "fixed", value: 200, min: 120, max: 320 })).toBe(
      "minmax(120px, 320px)",
    );
  });

  it("emits CSS Grid properties from the serialized layout", () => {
    const style = layoutStyle(fixture);
    expect(style.display).toBe("grid");
    expect(style.gridTemplateColumns).toBe("1fr minmax(120px, 320px) max-content");
    expect(style.gridTemplateRows).toBe("48px");
    expect(style.columnGap).toBe(8);
    expect(style.rowGap).toBe(12);
    expect(style.justifyItems).toBe("stretch");
    expect(style.alignItems).toBe("start");
  });

  it("places items by span or named region", () => {
    expect(placementStyle({ column: 2, row: 1, columnSpan: 2, rowSpan: 1 })).toEqual({
      gridColumn: "2 / span 2",
      gridRow: "1 / span 1",
    });
    expect(
      placementStyle({ column: 1, row: 1, columnSpan: 1, rowSpan: 1, region: "header" }),
    ).toEqual({ gridArea: "header" });
  });
});
