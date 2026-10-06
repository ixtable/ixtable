import { describe, expect, it } from "vitest";
import {
  compareKeys,
  layoutReport,
  measureText,
  normalizeText,
  type ReportDocument,
  wrapText,
} from "../../src/reports/engine";
import type { Report, TableComponent } from "../../src/reports/types";
import { band, baseReport, orders } from "./report-fixtures";

const texts = (doc: ReportDocument) =>
  doc.pages.map((p) =>
    p.items.flatMap((i) => (i.kind === "text" ? [[i.componentId, i.text, i.y]] : [])),
  );

describe("text metrics", () => {
  it("measures with the Helvetica AFM widths", () => {
    expect(measureText("Acme", 10)).toBe(25.56);
    expect(measureText("Acme", 10, true)).toBe(27.23);
    expect(measureText("€", 10)).toBe(5.56);
  });

  it("normalizes to what the standard and bundled fonts can print", () => {
    expect(normalizeText("a\tb\r\nc\u0001 € “q” ✓ 日 א")).toBe("a b\nc € “q” ✓ 日 ?");
  });

  it("wraps greedily on spaces, keeps explicit breaks and splits long words", () => {
    expect(wrapText("The quick brown fox", 50, 10)).toEqual(["The quick", "brown fox"]);
    expect(wrapText("one\n\ntwo", 100, 10)).toEqual(["one", "", "two"]);
    expect(wrapText("WWWWWWWW", 30, 10)).toEqual(["WWW", "WWW", "WW"]);
  });

  it("orders group keys totally and deterministically", () => {
    const keys = ["b", null, 2, "B", true, 10, "a"];
    expect([...keys].sort(compareKeys)).toEqual([null, true, 2, 10, "B", "a", "b"]);
  });
});

describe("layoutReport", () => {
  it("paginates detail bands and resolves page/pages in a second pass (golden)", () => {
    const report = baseReport({
      reportHeader: band(40, [
        {
          id: "title",
          kind: "staticText",
          text: "Sales report",
          x: 0,
          y: 0,
          w: 300,
          h: 20,
          style: { fontSize: 16, bold: true },
        },
      ]),
      detail: band(300, [
        { id: "name", kind: "field", expression: "record.customer", x: 0, y: 0, w: 100, h: 14 },
      ]),
      pageFooter: band(20, [
        {
          id: "pg",
          kind: "calculated",
          expression: "'Page ' & page & ' of ' & pages",
          x: 0,
          y: 0,
          w: 523,
          h: 14,
          style: { align: "right" },
        },
      ]),
    });
    const text = (componentId: string, x: number, y: number, w: number, h: number) => ({
      kind: "text",
      componentId,
      x,
      y,
      w,
      h,
      fontSize: 10,
      bold: false,
      gray: 0,
    });
    const doc = layoutReport(report, orders.slice(0, 3));
    expect(doc).toEqual({
      width: 595,
      height: 842,
      diagnostics: [],
      pages: [
        {
          number: 1,
          items: [
            {
              ...text("title", 36, 36, 300, 20),
              fontSize: 16,
              bold: true,
              text: "Sales report",
              lines: [{ text: "Sales report", x: 38, y: 49.69, width: 92.48 }],
            },
            {
              ...text("name", 36, 76, 100, 14),
              text: "Acme",
              lines: [{ text: "Acme", x: 38, y: 84.56, width: 25.56 }],
            },
            {
              ...text("name", 36, 376, 100, 14),
              text: "Birch",
              lines: [{ text: "Birch", x: 38, y: 384.56, width: 22.78 }],
            },
            {
              ...text("pg", 36, 786, 523, 14),
              text: "Page 1 of 2",
              lines: [{ text: "Page 1 of 2", x: 505.85, y: 794.56, width: 51.15 }],
            },
          ],
        },
        {
          number: 2,
          items: [
            {
              ...text("name", 36, 36, 100, 14),
              text: "Cobalt",
              lines: [{ text: "Cobalt", x: 38, y: 44.56, width: 28.9 }],
            },
            {
              ...text("pg", 36, 786, 523, 14),
              text: "Page 2 of 2",
              lines: [{ text: "Page 2 of 2", x: 505.85, y: 794.56, width: 51.15 }],
            },
          ],
        },
      ],
    });
  });

  const grouped = (keepTogether = false): Report =>
    baseReport({
      groups: [
        {
          id: "g1",
          groupBy: "record.region",
          header: band(
            20,
            [
              {
                id: "gh",
                kind: "field",
                expression: "record.region & ' (' & count(rows) & ')'",
                x: 0,
                y: 0,
                w: 200,
                h: 14,
                style: { bold: true },
              },
            ],
            keepTogether,
          ),
          footer: band(20, [
            {
              id: "gf",
              kind: "calculated",
              expression: "sum(rows.amount)",
              format: "#,##0.00",
              x: 400,
              y: 0,
              w: 100,
              h: 14,
            },
          ]),
        },
      ],
      detail: band(16, [
        { id: "c", kind: "field", expression: "record.customer", x: 10, y: 0, w: 100, h: 14 },
        {
          id: "a",
          kind: "field",
          expression: "record.amount",
          format: "#,##0.00",
          x: 400,
          y: 0,
          w: 100,
          h: 14,
        },
      ]),
      reportFooter: band(40, [
        {
          id: "total",
          kind: "calculated",
          expression: "sum(rows.amount)",
          format: "$#,##0.00",
          x: 400,
          y: 0,
          w: 100,
          h: 14,
        },
        {
          id: "sumof",
          kind: "calculated",
          expression: "sumof(rows, qty * price)",
          x: 400,
          y: 20,
          w: 100,
          h: 14,
        },
        { id: "cnt", kind: "calculated", expression: "count(rows)", x: 0, y: 0, w: 100, h: 14 },
      ]),
    });

  it("groups rows (stable, sorted by key) with group-scoped totals (golden)", () => {
    expect(texts(layoutReport(grouped(), orders))).toEqual([
      [
        ["gh", "East (2)", 36],
        ["c", "Birch", 56],
        ["a", "80.00", 56],
        ["c", "Dune", 72],
        ["a", "10.00", 72],
        ["gf", "90.00", 88],
        ["gh", "North (1)", 108],
        ["c", "Elm", 128],
        ["a", "300.00", 128],
        ["gf", "300.00", 144],
        ["gh", "West (2)", 164],
        ["c", "Acme", 184],
        ["a", "120.50", 184],
        ["c", "Cobalt", 200],
        ["a", "42.25", 200],
        ["gf", "162.75", 216],
        ["total", "$552.75", 236],
        ["sumof", "425", 256],
        ["cnt", "5", 236],
      ],
    ]);
  });

  it("sorts groups descending and keeps the input order inside a group", () => {
    const report = grouped();
    report.bands.groups[0].descending = true;
    const headers = texts(layoutReport(report, [...orders].reverse()))[0]
      .filter(([id]) => id === "gh" || id === "c")
      .map(([, text]) => text);
    expect(headers).toEqual([
      "West (2)",
      "Cobalt",
      "Acme",
      "North (1)",
      "Elm",
      "East (2)",
      "Dune",
      "Birch",
    ]);
  });

  it("breaks pages between groups and never orphans a keepTogether group header", () => {
    const loose = grouped(false);
    loose.bands.reportHeader = band(676);
    const tight = grouped(true);
    tight.bands.reportHeader = band(676);
    const firstOfPage2 = (r: Report) => texts(layoutReport(r, orders))[1][0];
    expect(texts(layoutReport(loose, orders))[0].at(-1)).toEqual(["gh", "North (1)", 784]);
    expect(firstOfPage2(loose)).toEqual(["c", "Elm", 36]);
    expect(texts(layoutReport(tight, orders))[0].at(-1)).toEqual(["gf", "90.00", 764]);
    expect(firstOfPage2(tight)).toEqual(["gh", "North (1)", 36]);
  });

  const tableReport = (keepTogether = false) => {
    const table: TableComponent = {
      id: "t",
      kind: "table",
      x: 0,
      y: 20,
      w: 300,
      h: 20,
      columns: [
        { id: "c1", header: "Customer", expression: "record.customer", width: 2 },
        {
          id: "c2",
          header: "Amount",
          expression: "record.amount",
          width: 1,
          align: "right",
          format: "0.00",
        },
      ],
    };
    return baseReport({
      pageHeader: band(20, [
        { id: "ph", kind: "staticText", text: "Header", x: 0, y: 0, w: 100, h: 14 },
      ]),
      reportFooter: band(
        60,
        [
          { id: "before", kind: "staticText", text: "Before", x: 0, y: 0, w: 100, h: 14 },
          table,
          { id: "after", kind: "staticText", text: "After", x: 0, y: 44, w: 100, h: 14 },
        ],
        keepTogether,
      ),
    });
  };
  const many = Array.from({ length: 60 }, (_, i) => ({ customer: `C${i + 1}`, amount: i }));

  it("splits a table across pages and repeats its header row (golden)", () => {
    const doc = layoutReport(tableReport(), many);
    const pages = texts(doc);
    expect(pages).toHaveLength(2);
    expect(pages[0].slice(0, 6)).toEqual([
      ["ph", "Header", 36],
      ["before", "Before", 56],
      ["t", "Customer", 76],
      ["t", "Amount", 76],
      ["t", "C1", 90.8],
      ["t", "0.00", 90.8],
    ]);
    expect(pages[0].at(-2)).toEqual(["t", "C48", 786.4]);
    expect(pages[1].slice(0, 5)).toEqual([
      ["ph", "Header", 36],
      ["t", "Customer", 56],
      ["t", "Amount", 56],
      ["t", "C49", 70.8],
      ["t", "48.00", 70.8],
    ]);
    expect(pages[1].at(-1)).toEqual(["after", "After", 252.4]);
    const cells = doc.pages[1].items.filter((i) => i.kind === "rect");
    expect(cells.slice(0, 2)).toEqual([
      {
        kind: "rect",
        componentId: "t",
        x: 36,
        y: 56,
        w: 200,
        h: 14.8,
        lineWidth: 0.5,
        gray: 0,
        fill: 0.9,
      },
      {
        kind: "rect",
        componentId: "t",
        x: 236,
        y: 56,
        w: 100,
        h: 14.8,
        lineWidth: 0.5,
        gray: 0,
        fill: 0.9,
      },
    ]);
    const amount = doc.pages[1].items.find((i) => i.kind === "text" && i.text === "48.00");
    expect(amount?.kind === "text" && amount.lines[0]).toEqual({
      text: "48.00",
      x: 310.48,
      y: 80.5,
      width: 22.52,
    });
  });

  it("moves a short keepTogether table band to the next page instead of splitting it", () => {
    const report = tableReport(true);
    report.bands.reportHeader = band(600);
    const doc = layoutReport(report, many.slice(0, 10));
    const pages = texts(doc);
    expect(pages[0]).toEqual([["ph", "Header", 36]]);
    expect(pages[1][1]).toEqual(["before", "Before", 56]);
    expect(pages[1].at(-1)).toEqual(["after", "After", 242.8]);
  });

  it("grows the band and shifts components below an unsplit table", () => {
    const doc = layoutReport(tableReport(), many.slice(0, 3));
    expect(texts(doc)[0].at(-1)).toEqual(["after", "After", 139.2]);
  });

  it("reads table rows from saved query data when the table has a queryId", () => {
    const report = tableReport();
    const table = report.bands.reportFooter.components[1] as TableComponent;
    table.queryId = "q1";
    const doc = layoutReport(report, many, { tables: { q1: [{ customer: "Only", amount: 1 }] } });
    expect(
      texts(doc)[0]
        .filter(([id]) => id === "t")
        .map(([, t]) => t),
    ).toEqual(["Customer", "Amount", "Only", "1.00"]);
    const missing = layoutReport(report, many);
    expect(missing.diagnostics).toEqual([
      { componentId: "t", message: "Table query data is not loaded" },
    ]);
  });

  it("renders shapes, images and placeholders, and reports expression errors", () => {
    const report = baseReport({
      detail: band(60, [
        {
          id: "ln",
          kind: "line",
          orientation: "horizontal",
          x: 0,
          y: 0,
          w: 100,
          h: 4,
          style: { borderWidth: 2 },
        },
        {
          id: "rc",
          kind: "rectangle",
          x: 0,
          y: 10,
          w: 50,
          h: 20,
          style: { fill: 0.8, borderWidth: 0 },
        },
        { id: "im", kind: "image", assetId: "logo", x: 60, y: 10, w: 40, h: 40 },
        { id: "gone", kind: "image", assetId: "nope", x: 110, y: 10, w: 40, h: 40 },
        { id: "bad", kind: "field", expression: "record.customer * 2", x: 200, y: 0, w: 80, h: 14 },
        {
          id: "fmt",
          kind: "field",
          expression: "params.when",
          format: "MMM d, yyyy",
          x: 300,
          y: 0,
          w: 80,
          h: 14,
        },
      ]),
    });
    const doc = layoutReport(report, orders.slice(0, 1), {
      assets: { logo: { mediaType: "image/jpeg" } },
      params: { when: "2026-01-05" },
    });
    const items = doc.pages[0].items;
    expect(items.slice(0, 3)).toEqual([
      { kind: "line", componentId: "ln", x: 36, y: 38, w: 100, h: 0, lineWidth: 2, gray: 0 },
      {
        kind: "rect",
        componentId: "rc",
        x: 36,
        y: 46,
        w: 50,
        h: 20,
        lineWidth: 0,
        gray: 0,
        fill: 0.8,
      },
      {
        kind: "image",
        componentId: "im",
        x: 96,
        y: 46,
        w: 40,
        h: 40,
        assetId: "logo",
        mediaType: "image/jpeg",
      },
    ]);
    expect(texts(doc)[0]).toEqual([
      ["gone", "Missing image", 46],
      ["bad", "#Error", 36],
      ["fmt", "Jan 5, 2026", 36],
    ]);
    expect(doc.diagnostics.map((d) => d.componentId)).toEqual(["gone", "bad"]);
  });

  it("is deterministic and always returns at least one page", () => {
    const report = grouped(true);
    expect(layoutReport(report, orders)).toEqual(layoutReport(report, orders));
    const empty = layoutReport(baseReport(), []);
    expect(empty.pages).toEqual([{ number: 1, items: [] }]);
  });

  it("uses landscape Letter dimensions and margins", () => {
    const report = baseReport({
      detail: band(14, [
        { id: "n", kind: "field", expression: "record.id", x: 0, y: 0, w: 50, h: 14 },
      ]),
    });
    report.page = {
      size: "Letter",
      orientation: "landscape",
      margins: { top: 10, right: 20, bottom: 30, left: 40 },
    };
    const doc = layoutReport(report, orders.slice(0, 1));
    expect([doc.width, doc.height]).toEqual([792, 612]);
    expect(texts(doc)[0]).toEqual([["n", "1", 10]]);
    expect(doc.pages[0].items[0].x).toBe(40);
  });
});
