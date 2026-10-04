import { describe, expect, it } from "vitest";
import {
  defaultGridLayout,
  detectOverlaps,
  layoutToCss,
  movePlacement,
  nextPlacement,
  normalizeLayout,
  normalizePlacement,
  placementsToCss,
  placementToCss,
  resizePlacement,
  resolveBreakpoint,
  resolvePlacements,
  resolveRegions,
  trackToCss,
  validateLayout,
} from "../../src/grid";
import type { GridLayout, Placement } from "../../src/grid";
import {
  layoutStyle,
  nextPlacement as formNextPlacement,
  placementStyle,
} from "../../src/design/schema";

const fr = (value = 1) => ({ kind: "fr" as const, value, min: null, max: null });
const at = (column: number, row: number, columnSpan = 1, rowSpan = 1): Placement => ({
  column,
  row,
  columnSpan,
  rowSpan,
  region: null,
});

const serialized = `{
  "columns": [
    {"kind": "fixed", "value": 120},
    {"kind": "content"},
    {"kind": "fr", "value": 2, "min": 80},
    {"kind": "fr", "value": 1, "max": 300}
  ],
  "rows": [{"kind": "content"}, {"kind": "fixed", "value": 48, "min": 60}],
  "columnGap": 12,
  "rowGap": 8,
  "padding": 4,
  "justifyItems": "start",
  "alignItems": "center",
  "namedRegions": [
    {"name": "header", "column": 1, "row": 1, "columnSpan": 4, "rowSpan": 1},
    {"name": "side", "column": 1, "row": 2, "columnSpan": 1, "rowSpan": 2},
    {"name": "main", "column": 2, "row": 2, "columnSpan": 3, "rowSpan": 1}
  ],
  "breakpoints": [
    {"minWidth": 0, "columns": [{"kind": "fr", "value": 1}]},
    {"minWidth": 600, "columns": [{"kind": "fr", "value": 1}, {"kind": "fr", "value": 1}]},
    {"minWidth": 900, "columns": [
      {"kind": "fixed", "value": 120}, {"kind": "content"},
      {"kind": "fr", "value": 2, "min": 80}, {"kind": "fr", "value": 1, "max": 300}
    ]}
  ]
}`;
const golden = (): GridLayout => normalizeLayout(JSON.parse(serialized));

describe("track and container CSS", () => {
  it("derives every track kind with min and max", () => {
    expect(trackToCss({ kind: "fixed", value: 120 })).toBe("120px");
    expect(trackToCss({ kind: "fixed", value: 120, min: 150 })).toBe("150px");
    expect(trackToCss({ kind: "fixed", value: 120, max: 100 })).toBe("100px");
    expect(trackToCss({ kind: "content" })).toBe("auto");
    expect(trackToCss({ kind: "content", min: 40, max: 200 })).toBe("minmax(40px, 200px)");
    expect(trackToCss({ kind: "content", max: 200 })).toBe("minmax(auto, 200px)");
    expect(trackToCss({ kind: "fr", value: 2 })).toBe("2fr");
    expect(trackToCss({ kind: "fr", value: 2, min: 80 })).toBe("minmax(80px, 2fr)");
    expect(trackToCss({ kind: "fr", value: 1, max: 300 })).toBe("minmax(0px, 300px)");
  });

  it("turns the golden layout into container CSS with no width", () => {
    expect(layoutToCss(golden())).toEqual({
      display: "grid",
      gridTemplateColumns: "120px auto minmax(80px, 2fr) minmax(0px, 300px)",
      gridTemplateRows: "auto 60px",
      gridTemplateAreas: '"header header header header" "side main main main" "side . . ."',
      gridAutoRows: "auto",
      columnGap: 12,
      rowGap: 8,
      padding: 4,
      justifyItems: "start",
      alignItems: "center",
    });
  });

  it("matches the default twelve column layout", () => {
    expect(layoutToCss(defaultGridLayout(), { width: 800 })).toEqual({
      display: "grid",
      gridTemplateColumns: Array(12).fill("1fr").join(" "),
      gridAutoRows: "auto",
      columnGap: 16,
      rowGap: 16,
      padding: 0,
      justifyItems: "stretch",
      alignItems: "stretch",
    });
  });

  it("keeps the schema.ts helpers working through the engine", () => {
    expect(layoutStyle(golden())).toEqual(layoutToCss(golden()));
    expect(placementStyle(at(2, 3, 4, 2))).toEqual({
      gridColumn: "2 / span 4",
      gridRow: "3 / span 2",
    });
    expect(placementStyle({ ...at(1, 1), region: "main" })).toEqual({ gridArea: "main" });
    expect(placementStyle({ ...at(1, 1), region: "main" }, golden())).toEqual({ gridArea: "main" });
  });
});

describe("breakpoints", () => {
  it("picks the largest minWidth at or below the width, mobile first", () => {
    const layout = golden();
    expect(resolveBreakpoint(layout).index).toBe(-1);
    expect(resolveBreakpoint(layout, 0).index).toBe(0);
    expect(resolveBreakpoint(layout, 599).index).toBe(0);
    expect(resolveBreakpoint(layout, 600).index).toBe(1);
    expect(resolveBreakpoint(layout, 2000).index).toBe(2);
    expect(layoutToCss(layout, { width: 700 }).gridTemplateColumns).toBe("1fr 1fr");
  });

  it("uses the base columns below every breakpoint and lets the later tie win", () => {
    const layout = {
      ...defaultGridLayout(),
      breakpoints: [
        { minWidth: 500, columns: [fr()] },
        { minWidth: 500, columns: [fr(), fr()] },
        { minWidth: 800, columns: [] },
      ],
    };
    expect(resolveBreakpoint(layout, 400)).toEqual({ columns: layout.columns, index: -1 });
    expect(resolveBreakpoint(layout, 500).index).toBe(1);
    expect(resolveBreakpoint(layout, 900).index).toBe(1);
  });
});

describe("wrapping", () => {
  const layout: GridLayout = {
    ...defaultGridLayout(),
    breakpoints: [
      { minWidth: 0, columns: [fr(), fr(), fr(), fr()] },
      { minWidth: 600, columns: Array.from({ length: 8 }, () => fr()) },
      { minWidth: 1000, columns: Array.from({ length: 12 }, () => fr()) },
    ],
  };
  const items = [at(1, 1, 6), at(7, 1, 6), at(1, 2, 12), at(1, 3, 3, 2), at(4, 3, 9)];

  it("keeps authored positions when everything fits", () => {
    expect(resolvePlacements(layout, items, 1200)).toEqual(items);
    expect(resolvePlacements(layout, items)).toEqual(items);
  });

  it("clamps spans and flows overflowing items to the next free row", () => {
    expect(resolvePlacements(layout, items, 700)).toEqual([
      at(1, 1, 6),
      at(1, 2, 6),
      at(1, 3, 8),
      at(1, 4, 3, 2),
      at(1, 6, 8),
    ]);
    expect(resolvePlacements(layout, items, 300)).toEqual([
      at(1, 1, 4),
      at(1, 2, 4),
      at(1, 3, 4),
      at(1, 4, 3, 2),
      at(1, 6, 4),
    ]);
  });

  it("orders by authored row and column, not array order", () => {
    const shuffled = [items[4], items[2], items[0], items[3], items[1]];
    const css = placementsToCss(layout, shuffled, 300);
    expect(css).toEqual([
      { gridColumn: "1 / span 4", gridRow: "6 / span 1" },
      { gridColumn: "1 / span 4", gridRow: "3 / span 1" },
      { gridColumn: "1 / span 4", gridRow: "1 / span 1" },
      { gridColumn: "1 / span 3", gridRow: "4 / span 2" },
      { gridColumn: "1 / span 4", gridRow: "2 / span 1" },
    ]);
  });

  it("clamps a lone placement to the active columns", () => {
    expect(placementToCss(at(7, 2, 6), layout, 300)).toEqual({
      gridColumn: "1 / span 4",
      gridRow: "2 / span 1",
    });
  });

  it("wraps named regions into template areas", () => {
    expect(layoutToCss(golden(), { width: 700 }).gridTemplateAreas).toBe(
      '"header header" "side ." "side ." "main main"',
    );
    expect(layoutToCss(golden(), { width: 100 }).gridTemplateAreas).toBe(
      '"header" "side" "side" "main"',
    );
    expect(placementToCss({ ...at(1, 1), region: "main" }, golden(), 100)).toEqual({
      gridArea: "main",
    });
  });
});

describe("regions", () => {
  it("uses safe identifiers and drops overlapping regions from the template", () => {
    const layout: GridLayout = {
      ...defaultGridLayout(),
      columns: [fr(), fr(), fr()],
      namedRegions: [
        { name: "Top bar", column: 1, row: 1, columnSpan: 3, rowSpan: 1 },
        { name: "auto", column: 1, row: 2, columnSpan: 1, rowSpan: 1 },
        { name: "clash", column: 3, row: 1, columnSpan: 1, rowSpan: 2 },
      ],
    };
    expect(resolveRegions(layout).map((region) => [region.ident, region.inTemplate])).toEqual([
      ["_0", true],
      ["_1", true],
      ["clash", false],
    ]);
    expect(layoutToCss(layout).gridTemplateAreas).toBe('"_0 _0 _0" "_1 . ."');
    expect(placementToCss({ ...at(1, 1), region: "Top bar" }, layout)).toEqual({ gridArea: "_0" });
    expect(placementToCss({ ...at(1, 1), region: "clash" }, layout)).toEqual({
      gridColumn: "3 / span 1",
      gridRow: "1 / span 2",
    });
    expect(placementToCss({ ...at(2, 4), region: "missing" }, layout)).toEqual({
      gridColumn: "2 / span 1",
      gridRow: "4 / span 1",
    });
  });
});

describe("editing", () => {
  const layout = defaultGridLayout();

  it("clamps resizing within the grid and item constraints", () => {
    expect(resizePlacement(at(1, 1, 4), { columns: 2 }, layout)).toEqual(at(1, 1, 6));
    expect(resizePlacement(at(10, 1, 3), { columns: 5 }, layout)).toEqual(at(10, 1, 3));
    expect(resizePlacement(at(1, 1, 1), { columns: -3, rows: -2 }, layout)).toEqual(at(1, 1, 1));
    const limits = { minColumnSpan: 2, maxColumnSpan: 6, minRowSpan: 1, maxRowSpan: 3 };
    expect(resizePlacement(at(1, 1, 4, 2), { columns: 9, rows: 9 }, layout, limits)).toEqual(
      at(1, 1, 6, 3),
    );
    expect(resizePlacement(at(1, 1, 4), { columns: -9 }, layout, limits)).toEqual(at(1, 1, 2));
    expect(resizePlacement(at(12, 1, 1), { columns: 1 }, layout, limits)).toEqual(at(12, 1, 1));
    const regionPlacement = { ...at(1, 1), region: "main" };
    expect(resizePlacement(regionPlacement, { columns: 1 }, layout)).toBe(regionPlacement);
  });

  it("moves within the grid", () => {
    expect(movePlacement(at(1, 1, 4), { columns: 20, rows: -3 }, layout)).toEqual(at(9, 1, 4));
    expect(movePlacement(at(5, 2, 4), { columns: -1, rows: 1 }, layout)).toEqual(at(4, 3, 4));
  });

  it("finds the first free slot", () => {
    expect(nextPlacement(layout, [])).toEqual(at(1, 1, 12));
    expect(nextPlacement(layout, [at(1, 1, 6), at(1, 3, 12)])).toEqual(at(1, 2, 12));
    expect(nextPlacement(layout, [at(1, 1, 6)], { columnSpan: 6 })).toEqual(at(7, 1, 6));
    expect(nextPlacement(golden(), [{ ...at(1, 1), region: "header" }], { columnSpan: 1 })).toEqual(
      at(1, 2, 1),
    );
    const form = {
      id: "f",
      name: "F",
      layout,
      controls: [
        {
          id: "a",
          kind: "text" as const,
          label: "A",
          validation: { required: false },
          placement: at(1, 1, 12, 2),
        },
      ],
    };
    expect(formNextPlacement(form)).toEqual(at(1, 3, 12));
  });

  it("detects overlaps including shared regions", () => {
    const items = [
      { id: "a", placement: at(1, 1, 6) },
      { id: "b", placement: at(6, 1, 2) },
      { id: "c", placement: at(8, 1, 2) },
      { id: "d", placement: { ...at(1, 1), region: "header" } },
      { id: "e", placement: { ...at(1, 1), region: "header" } },
    ];
    expect(detectOverlaps(items)).toEqual([
      ["a", "b"],
      ["d", "e"],
    ]);
    expect(detectOverlaps(items.slice(0, 4), golden())).toEqual([
      ["a", "b"],
      ["a", "d"],
    ]);
  });
});

describe("validation", () => {
  it("accepts the golden and default layouts", () => {
    expect(
      validateLayout(golden(), [{ id: "x", placement: { ...at(1, 1), region: "main" } }]),
    ).toEqual([]);
    expect(validateLayout(defaultGridLayout(), [{ id: "x", placement: at(1, 1, 12) }])).toEqual([]);
  });

  it("mirrors the Rust errors and adds rendering warnings", () => {
    const layout: GridLayout = {
      ...defaultGridLayout(),
      columns: [fr(), { kind: "fixed", value: 0 }],
      rows: [{ kind: "fr", value: 1, min: 50, max: 10 }],
      columnGap: 1.5,
      namedRegions: [
        { name: "a", column: 1, row: 1, columnSpan: 2, rowSpan: 1 },
        { name: "a", column: 2, row: 1, columnSpan: 1, rowSpan: 1 },
      ],
      breakpoints: [
        { minWidth: 10, columns: [] },
        { minWidth: 10, columns: [fr()] },
      ],
    };
    const issues = validateLayout(
      layout,
      [
        { id: "wide", placement: at(2, 1, 2) },
        { id: "zero", placement: at(0, 1) },
        { id: "lost", placement: { ...at(1, 1), region: "nowhere" } },
        { id: "half", placement: at(1.5, 1) },
      ],
      { objectKind: "form", objectId: "f1", itemKind: "control" },
    );
    const summary = issues.map(
      (issue) => `${issue.severity} ${issue.objectKind}:${issue.objectId} ${issue.message}`,
    );
    expect(summary).toEqual([
      "error form:f1 columns tracks need a positive size",
      "error form:f1 rows track minimum cannot exceed maximum",
      "warning form:f1 breakpoint has no columns and is ignored",
      "warning form:f1 more than one breakpoint starts at 10px; the last one wins",
      "error form:f1 gaps and padding must be whole pixels up to 65535",
      "error form:f1 named grid regions must be unique",
      "warning form:f1 region a overlaps region a and is left out of the template",
      "error control:wide grid placement exceeds declared columns",
      "error control:zero grid placement uses 1-based positions and positive spans",
      "error control:lost placement references an unknown region",
      "error control:half grid positions and spans must be whole numbers up to 65535",
      "warning control:wide overlaps half",
    ]);
    expect(validateLayout({ ...defaultGridLayout(), columns: [] }, [])[0].message).toBe(
      "grid layout requires at least one column track",
    );
  });
});

describe("serialization", () => {
  it("round-trips through JSON without drift", () => {
    const layout = golden();
    expect(normalizeLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    expect(JSON.stringify(normalizeLayout(JSON.parse(JSON.stringify(layout))))).toBe(
      JSON.stringify(layout),
    );
    const placement = { ...at(2, 3, 4), region: "main" };
    expect(normalizePlacement(JSON.parse(JSON.stringify(placement)))).toEqual(placement);
  });

  it("fills serde defaults in Rust field order", () => {
    expect(JSON.stringify(normalizeLayout({}))).toBe(JSON.stringify(defaultGridLayout()));
    expect(Object.keys(normalizeLayout({}))).toEqual([
      "columns",
      "rows",
      "columnGap",
      "rowGap",
      "padding",
      "justifyItems",
      "alignItems",
      "namedRegions",
      "breakpoints",
    ]);
    expect(normalizeLayout({ columns: [] }).columns).toEqual([]);
    expect(normalizePlacement({})).toEqual(at(1, 1));
  });

  it("never persists derived CSS", () => {
    const polluted = {
      ...golden(),
      gridTemplateColumns: "1fr 1fr",
      style: { display: "grid" },
      columns: [{ kind: "fr", value: 1, css: "minmax(0, 1fr)" }],
    };
    const json = JSON.stringify(normalizeLayout(polluted));
    expect(json).not.toMatch(/gridTemplate|minmax|"display"|\dfr|\dpx|"css"/);
    expect(JSON.stringify(normalizePlacement({ ...at(1, 1), gridColumn: "1 / span 2" }))).toBe(
      JSON.stringify(at(1, 1)),
    );
  });
});
