import { describe, expect, it } from "vitest";
import { layoutReport, type PositionedItem, type ReportDocument } from "../../src/reports/engine";
import { cutAt, sliceItems } from "../../src/reports/engine/split";
import type { ReportComponent } from "../../src/reports/types";
import { band, baseReport } from "./report-fixtures";

const words = Array.from({ length: 600 }, (_, i) => `w${i}`);
const memo: ReportComponent = {
  id: "memo",
  kind: "field",
  expression: "record.memo",
  x: 0,
  y: 0,
  w: 100,
  h: 14,
  canGrow: true,
  style: { borderWidth: 1 },
};
const beside: ReportComponent = {
  id: "beside",
  kind: "staticText",
  text: "beside",
  x: 150,
  y: 0,
  w: 100,
  h: 14,
};
const after: ReportComponent = {
  id: "after",
  kind: "staticText",
  text: "after",
  x: 0,
  y: 20,
  w: 100,
  h: 14,
};
const footer = band(20, [
  { id: "pf", kind: "calculated", expression: "'Page ' & page", x: 0, y: 0, w: 100, h: 14 },
]);
const BODY_TOP = 36;
const BODY_BOTTOM = 842 - 36 - 20;

const of = (doc: ReportDocument, id: string) =>
  doc.pages.flatMap((p, page) =>
    p.items.filter((i) => i.componentId === id).map((i) => ({ ...i, page })),
  );
const texts = (doc: ReportDocument, id: string) =>
  of(doc, id).flatMap((i) => (i.kind === "text" ? [i] : []));

describe("splitting grown text across pages", () => {
  it("continues a band taller than a page on the next pages without losing lines", () => {
    const doc = layoutReport(
      baseReport({ detail: band(40, [memo, beside, after]), pageFooter: footer }),
      [{ memo: words.join(" ") }],
    );
    expect(doc.pages.length).toBeGreaterThanOrEqual(3);
    const pieces = texts(doc, "memo");
    expect(pieces.map((p) => p.page)).toEqual(doc.pages.map((_, i) => i));
    const printed = pieces.flatMap((p) => p.lines.map((l) => l.text)).join(" ");
    expect(printed).toBe(words.join(" "));
    for (const piece of pieces) {
      expect(piece.y + piece.h).toBeLessThanOrEqual(BODY_BOTTOM + 0.01);
      for (const line of piece.lines) expect(line.y).toBeLessThan(BODY_BOTTOM);
    }
    for (const piece of pieces.slice(1)) expect(piece.y).toBe(BODY_TOP);
    const frames = of(doc, "memo").filter((i) => i.kind === "rect");
    expect(frames.map((f) => f.page)).toEqual(pieces.map((p) => p.page));
    expect(texts(doc, "pf").map((t) => t.lines[0].text)).toEqual(
      doc.pages.map((_, i) => `Page ${i + 1}`),
    );
    const [last] = pieces.slice(-1);
    const [below] = texts(doc, "after");
    expect(below.page).toBe(last.page);
    expect(below.y).toBeCloseTo(last.y + last.h + 6, 2);
  });

  it("keeps a side-by-side sibling in place on the first page", () => {
    const doc = layoutReport(baseReport({ detail: band(40, [memo, beside]) }), [
      { memo: words.join(" ") },
    ]);
    const siblings = texts(doc, "beside");
    expect(siblings).toHaveLength(1);
    expect(siblings[0]).toMatchObject({ page: 0, y: BODY_TOP, h: 14 });
    expect(texts(doc, "memo")[0]).toMatchObject({ page: 0, y: BODY_TOP });
  });

  it("starts a grown band on the current page and moves it whole when keepTogether fits", () => {
    const filler: ReportComponent = { ...after, id: "filler", y: 0 };
    const short = words.slice(0, 40).join(" ");
    const rows = [{ memo: "x" }, { memo: short }];
    const report = (keepTogether: boolean) =>
      baseReport({
        reportHeader: band(650, [filler]),
        detail: band(40, [memo], keepTogether),
      });
    const split = layoutReport(report(false), rows);
    expect(texts(split, "memo").map((t) => t.page)).toEqual([0, 0, 1]);
    const kept = layoutReport(report(true), rows);
    const pieces = texts(kept, "memo");
    expect(pieces.map((t) => t.page)).toEqual([0, 1]);
    expect(pieces[1].y).toBe(BODY_TOP);
    expect(pieces[1].lines.map((l) => l.text).join(" ")).toBe(short);
  });

  it("is deterministic", () => {
    const report = baseReport({ detail: band(40, [memo, after]), pageFooter: footer });
    const rows = [{ memo: words.join(" ") }];
    expect(layoutReport(report, rows)).toEqual(layoutReport(report, rows));
  });
});

describe("cut and slice helpers", () => {
  const text = (y: number, lineCount: number): PositionedItem => ({
    kind: "text",
    componentId: "t",
    x: 0,
    y,
    w: 100,
    h: lineCount * 12,
    text: "",
    fontSize: 10,
    bold: false,
    gray: 0,
    lines: Array.from({ length: lineCount }, (_, i) => ({
      text: `l${i}`,
      x: 2,
      y: y + i * 12 + 8.555,
      width: 10,
    })),
  });
  const image: PositionedItem = {
    kind: "image",
    componentId: "img",
    x: 0,
    y: 50,
    w: 20,
    h: 30,
    assetId: "a",
    mediaType: "image/png",
  };

  it("cuts between lines and above an image that would cross the cut", () => {
    expect(cutAt([text(0, 10)], 0, 65)).toBeCloseTo(60, 6);
    expect(cutAt([text(0, 10), image], 0, 65)).toBeCloseTo(48, 6);
    expect(cutAt([image], 50, 65)).toBe(50);
  });

  it("slices text by line start and clips rectangles", () => {
    const frame: PositionedItem = {
      kind: "rect",
      componentId: "t",
      x: 0,
      y: 0,
      w: 100,
      h: 120,
      lineWidth: 1,
      gray: 0,
      fill: null,
    };
    const second = sliceItems([text(0, 10), frame], 60, Number.POSITIVE_INFINITY, 36 - 60);
    const t = second.find((i) => i.kind === "text");
    expect(t?.kind === "text" && t.lines.map((l) => l.text)).toEqual([
      "l5",
      "l6",
      "l7",
      "l8",
      "l9",
    ]);
    expect(t).toMatchObject({ y: 36, h: 60 });
    expect(second.find((i) => i.kind === "rect")).toMatchObject({ y: 36, h: 60 });
  });
});
