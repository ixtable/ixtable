import { describe, expect, it } from "vitest";
import {
  GROW_WITH_TABLE,
  layoutReport,
  LINE_HEIGHT,
  type ReportDocument,
} from "../../src/reports/engine";
import type { ReportComponent } from "../../src/reports/types";
import { band, baseReport } from "./report-fixtures";

const long = "lorem ipsum dolor sit amet ".repeat(8).trim();
const lineHeight = 10 * LINE_HEIGHT;

const note = (patch: Partial<ReportComponent> = {}): ReportComponent =>
  ({
    id: "note",
    kind: "field",
    expression: "record.note",
    x: 0,
    y: 0,
    w: 100,
    h: 14,
    canGrow: true,
    style: { borderWidth: 1 },
    ...patch,
  }) as ReportComponent;
const below: ReportComponent = {
  id: "below",
  kind: "staticText",
  text: "after",
  x: 150,
  y: 20,
  w: 100,
  h: 14,
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

const items = (doc: ReportDocument, id: string) =>
  doc.pages.flatMap((p, page) =>
    p.items.filter((i) => i.componentId === id).map((i) => ({ page, ...i })),
  );

describe("can grow", () => {
  it("grows the box and band and pushes components below it down", () => {
    const report = baseReport({ detail: band(40, [note(), beside, below]) });
    const doc = layoutReport(report, [{ note: long }, { note: "short" }]);
    const [text, second] = items(doc, "note").filter((i) => i.kind === "text");
    if (text.kind !== "text") throw new Error("text");
    const lines = text.lines.length;
    expect(lines).toBeGreaterThan(5);
    const grow = lines * lineHeight - 14;
    expect(text.h).toBeCloseTo(14 + grow, 2);
    const frame = items(doc, "note").find((i) => i.kind === "rect");
    expect(frame?.h).toBeCloseTo(14 + grow, 2);
    expect(items(doc, "beside")[0].y).toBe(36);
    expect(items(doc, "below")[0].y).toBeCloseTo(36 + 20 + grow, 2);
    expect(second.y).toBeCloseTo(36 + 40 + grow, 2);
    expect(items(doc, "below")[1].y).toBe(36 + 40 + grow + 20);
  });

  it("chains growth through stacked boxes and keeps text that fits unchanged", () => {
    const second = note({ id: "second", y: 20 });
    const doc = layoutReport(
      baseReport({ detail: band(48, [note(), second, { ...below, y: 34 }]) }),
      [{ note: long }],
    );
    const first = items(doc, "note").find((i) => i.kind === "text");
    const next = items(doc, "second").find((i) => i.kind === "text");
    if (first?.kind !== "text" || next?.kind !== "text") throw new Error("text");
    const grow = first.h - 14;
    expect(next.y).toBeCloseTo(36 + 20 + grow, 2);
    expect(next.h).toBeCloseTo(first.h, 2);
    expect(items(doc, "below")[0].y).toBeCloseTo(36 + 34 + 2 * grow, 2);
    const fits = layoutReport(baseReport({ detail: band(40, [note(), below]) }), [{ note: "x" }]);
    const plain = layoutReport(
      baseReport({ detail: band(40, [note({ canGrow: undefined }), below]) }),
      [{ note: "x" }],
    );
    expect(fits).toEqual(plain);
  });

  it("clips text without can grow, as before", () => {
    const doc = layoutReport(baseReport({ detail: band(40, [note({ canGrow: undefined })]) }), [
      { note: long },
    ]);
    const text = items(doc, "note").find((i) => i.kind === "text");
    expect(text?.kind === "text" && text.lines.length).toBe(1);
    expect(text?.h).toBe(14);
  });

  it("paginates by the grown height", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ note: i === 0 ? long : "x" }));
    const fixed = layoutReport(
      baseReport({ detail: band(38, [note({ canGrow: undefined })]) }),
      rows,
    );
    expect(fixed.pages.length).toBe(1);
    const doc = layoutReport(baseReport({ detail: band(38, [note()]) }), rows);
    expect(doc.pages.length).toBe(2);
    const texts = items(doc, "note").filter((i) => i.kind === "text");
    expect(texts[texts.length - 1].page).toBe(1);
    expect(texts.find((t) => t.page === 1)?.y).toBe(36);
    expect(layoutReport(baseReport({ detail: band(38, [note()]) }), rows)).toEqual(doc);
  });

  it("repeats a grown group header at its grown height", () => {
    const header = band(20, [note({ id: "gh", expression: "record.note" })]);
    const report = baseReport({
      groups: [{ id: "g", groupBy: "1", header, footer: band(0), repeatHeader: true }],
      detail: band(500, [{ ...below, y: 0 }]),
    });
    const doc = layoutReport(report, [{ note: long }, { note: long }, { note: long }]);
    const heads = items(doc, "gh").filter((i) => i.kind === "text");
    expect(heads.map((h) => h.page)).toEqual([0, 1, 2]);
    const grownHeight = heads[0].h + 6;
    for (const page of [1, 2])
      expect(items(doc, "below").find((i) => i.page === page)?.y).toBeCloseTo(36 + grownHeight, 2);
  });

  it("is ignored in a band with a table, with a diagnostic", () => {
    const table: ReportComponent = {
      id: "tbl",
      kind: "table",
      x: 0,
      y: 20,
      w: 200,
      h: 20,
      columns: [{ id: "c", header: "Note", expression: "record.note", width: 1 }],
    };
    const doc = layoutReport(baseReport({ detail: band(40, [note(), table]) }), [{ note: long }]);
    expect(items(doc, "note").find((i) => i.kind === "text")?.h).toBe(14);
    expect(doc.diagnostics).toContainEqual({ componentId: "note", message: GROW_WITH_TABLE });
  });
});
