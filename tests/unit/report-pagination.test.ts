import { describe, expect, it } from "vitest";
import { layoutReport, PAGE_BAND_TABLE, type ReportDocument } from "../../src/reports/engine";
import type { Band, ReportComponent, ReportGroup } from "../../src/reports/types";
import { band, baseReport, orders } from "./report-fixtures";

// A4 portrait with 36 pt margins: the body runs from y=36 to y=806.
const field = (id: string, expression: string): ReportComponent => ({
  id,
  kind: "field",
  expression,
  x: 0,
  y: 0,
  w: 300,
  h: 14,
});
const pageNumbers = "groupPage & '/' & groupPages & ' ' & page & '/' & pages";

/** Per page: [componentId, text, box y] of every text item. */
const texts = (doc: ReportDocument) =>
  doc.pages.map((p) =>
    p.items.flatMap((i) => (i.kind === "text" ? [[i.componentId, i.text, i.y]] : [])),
  );

const byRegion = (patch: Partial<ReportGroup> = {}, height = 30): ReportGroup => ({
  id: "g1",
  groupBy: "record.region",
  header: band(height, [field("gh", "record.region")]),
  footer: band(0),
  ...patch,
});

const flagged = (b: Band, flags: Partial<Band>): Band => ({ ...b, ...flags });

describe("pagination controls", () => {
  it("defaults keep the original layout and groupPage follows page", () => {
    const doc = layoutReport(
      baseReport({
        detail: band(300, [field("d", "record.customer")]),
        pageFooter: band(20, [field("pf", pageNumbers)]),
      }),
      orders,
    );
    expect(texts(doc).map((p) => p.find((t) => t[0] === "pf")?.[1])).toEqual([
      "1/3 1/3",
      "2/3 2/3",
      "3/3 3/3",
    ]);
  });

  it("breaks before a band, but never leaves the first page blank", () => {
    const detail = flagged(band(20, [field("d", "record.customer")]), { pageBreakBefore: true });
    const doc = layoutReport(baseReport({ detail }), orders.slice(0, 3));
    expect(texts(doc)).toEqual([[["d", "Acme", 36]], [["d", "Birch", 36]], [["d", "Cobalt", 36]]]);
  });

  it("breaks after a band without a trailing blank page", () => {
    const doc = layoutReport(
      baseReport({
        reportHeader: flagged(band(40, [field("t", "'Title'")]), { pageBreakAfter: true }),
        detail: band(20, [field("d", "record.customer")]),
        reportFooter: flagged(band(20, [field("f", "'End'")]), { pageBreakAfter: true }),
      }),
      orders.slice(0, 2),
    );
    expect(texts(doc)).toEqual([
      [["t", "Title", 36]],
      [
        ["d", "Acme", 36],
        ["d", "Birch", 56],
        ["f", "End", 76],
      ],
    ]);
  });

  it("starts every group on a new page", () => {
    const doc = layoutReport(
      baseReport({
        groups: [byRegion({ newPage: true })],
        detail: band(20, [field("d", "record.customer")]),
      }),
      orders,
    );
    expect(texts(doc)).toEqual([
      [
        ["gh", "East", 36],
        ["d", "Birch", 66],
        ["d", "Dune", 86],
      ],
      [
        ["gh", "North", 36],
        ["d", "Elm", 66],
      ],
      [
        ["gh", "West", 36],
        ["d", "Acme", 66],
        ["d", "Cobalt", 86],
      ],
    ]);
  });

  it("repeats a group header on continuation pages only when asked", () => {
    const report = (repeatHeader: boolean) =>
      baseReport({
        groups: [byRegion({ repeatHeader })],
        detail: band(300, [field("d", "record.customer")]),
      });
    expect(texts(layoutReport(report(true), orders))).toEqual([
      [
        ["gh", "East", 36],
        ["d", "Birch", 66],
        ["d", "Dune", 366],
        ["gh", "North", 666],
      ],
      [
        ["gh", "North", 36],
        ["d", "Elm", 66],
        ["gh", "West", 366],
        ["d", "Acme", 396],
      ],
      [
        ["gh", "West", 36],
        ["d", "Cobalt", 66],
      ],
    ]);
    expect(texts(layoutReport(report(false), orders))).toEqual([
      [
        ["gh", "East", 36],
        ["d", "Birch", 66],
        ["d", "Dune", 366],
        ["gh", "North", 666],
      ],
      [
        ["d", "Elm", 36],
        ["gh", "West", 336],
        ["d", "Acme", 366],
      ],
      [["d", "Cobalt", 36]],
    ]);
  });

  it("repeats the group header above each continuation of a split table", () => {
    const table: ReportComponent = {
      id: "tbl",
      kind: "table",
      x: 0,
      y: 0,
      w: 300,
      h: 40,
      columns: [{ id: "c", header: "Customer", expression: "record.customer", width: 300 }],
    };
    const rows = Array.from({ length: 80 }, (_, i) => ({ region: "West", customer: `C${i}` }));
    const doc = layoutReport(
      baseReport({ groups: [{ ...byRegion({ repeatHeader: true }), footer: band(40, [table]) }] }),
      rows,
    );
    expect(doc.pages.length).toBeGreaterThan(1);
    for (const page of texts(doc).slice(1)) {
      expect(page[0]).toEqual(["gh", "West", 36]);
      // The table's header row continues directly below the repeated group header.
      expect(page[1].slice(1)).toEqual(["Customer", 66]);
    }
  });

  it("restarts groupPage and groupPages per group, keeping page and pages", () => {
    const doc = layoutReport(
      baseReport({
        groups: [byRegion({ resetPageNumber: true }, 20)],
        detail: band(400, [field("d", "record.customer")]),
        pageFooter: band(20, [field("pf", pageNumbers)]),
      }),
      orders,
    );
    expect(texts(doc).map((p) => [p[0][1], p.find((t) => t[0] === "pf")?.[1]])).toEqual([
      ["East", "1/2 1/5"],
      ["Dune", "2/2 2/5"],
      ["North", "1/1 3/5"],
      ["West", "1/2 4/5"],
      ["Cobalt", "2/2 5/5"],
    ]);
  });

  it("honours page breaks and section starts on empty group headers", () => {
    const doc = layoutReport(
      baseReport({
        groups: [{ ...byRegion({ resetPageNumber: true }), header: band(0) }],
        detail: band(20, [field("d", "record.customer")]),
        pageFooter: band(20, [field("pf", pageNumbers)]),
      }),
      orders,
    );
    expect(texts(doc).map((p) => p.map((t) => t[1]))).toEqual([
      ["Birch", "Dune", "1/1 1/3"],
      ["Elm", "1/1 2/3"],
      ["Acme", "Cobalt", "1/1 3/3"],
    ]);
  });

  it("reports a table in a page band instead of dropping it silently", () => {
    const table: ReportComponent = {
      id: "ptbl",
      kind: "table",
      x: 0,
      y: 0,
      w: 100,
      h: 20,
      columns: [],
    };
    const doc = layoutReport(baseReport({ pageHeader: band(20, [table]) }), []);
    expect(doc.diagnostics).toContainEqual({ componentId: "ptbl", message: PAGE_BAND_TABLE });
  });
});
