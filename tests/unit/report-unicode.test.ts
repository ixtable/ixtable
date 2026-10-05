import { describe, expect, it } from "vitest";
import {
  fallbackGlyph,
  layoutReport,
  measureText,
  normalizeText,
  type ReportDocument,
  textRuns,
  wrapText,
} from "../../src/reports/engine";
import { fallbackCodePoints } from "../../src/reports/export";
import { num, writePdf } from "../../src/reports/pdf";
import type { PdfFontSubset } from "../../src/reports/pdf-fonts";
import { decodedImage, pngImage } from "../../src/reports/pdf-images";
import { band, baseReport } from "./report-fixtures";

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");
const options = { creationDate: "2026-01-01T00:00:00Z" };

describe("fallback font metrics", () => {
  it("keeps Greek, Cyrillic, CJK and symbols and replaces the rest with ?", () => {
    expect(normalizeText("Ωμέγα Жук 漢字 → ✓")).toBe("Ωμέγα Жук 漢字 → ✓");
    expect(normalizeText("שלום سلام")).toBe("???? ????");
    expect(fallbackGlyph("A")).toBeNull();
    expect(fallbackGlyph("€")).toBeNull();
    expect(fallbackGlyph("Ω")?.font).toBe(0);
    expect(fallbackGlyph("漢")).toEqual({ font: 1, width: 1000 });
  });

  it("measures and wraps CJK text with the fallback widths", () => {
    expect(measureText("漢字", 10)).toBe(20);
    expect(measureText("漢字", 10, true)).toBe(20);
    expect(wrapText("漢字漢字漢字", 35, 10)).toEqual(["漢字漢", "字漢字"]);
  });

  it("splits lines into font runs with offsets", () => {
    const runs = textRuns("Ab Ω漢", 10);
    expect(runs.map((r) => [r.text, r.font])).toEqual([
      ["Ab ", -1],
      ["Ω", 0],
      ["漢", 1],
    ]);
    expect(runs[1].dx).toBeCloseTo(measureText("Ab ", 10));
    expect(runs[2].dx).toBeCloseTo(measureText("Ab Ω", 10));
  });
});

const fonts: PdfFontSubset[] = [
  {
    index: 0,
    baseFont: "AAAAAA+DejaVuSans",
    dataBase64: btoa("FONT0"),
    length1: 100,
    bbox: [-1021, -463, 1793, 1232],
    ascent: 928,
    descent: -236,
    capHeight: 729,
    glyphs: [{ codePoint: 0x3a9, cid: 1, width: 765 }],
  },
  {
    index: 1,
    baseFont: "BBBBBB+DroidSansFallback",
    dataBase64: btoa("FONT1"),
    length1: 200,
    bbox: [0, -100, 1000, 900],
    ascent: 1050,
    descent: -270,
    capHeight: 1050,
    glyphs: [
      { codePoint: 0x6f22, cid: 2, width: 1000 },
      { codePoint: 0x20bb7, cid: 1, width: 1000 },
    ],
  },
];

function doc(text: string, bold = false): ReportDocument {
  return layoutReport(
    baseReport({
      detail: band(20, [
        { id: "t", kind: "staticText", text, x: 0, y: 0, w: 300, h: 14, style: { bold } },
      ]),
    }),
    [{}],
  );
}

describe("pdf fallback fonts", () => {
  it("embeds Type0 fonts and draws fallback runs as CIDs", () => {
    const layout = doc("Ab Ω漢");
    expect(fallbackCodePoints(layout)).toEqual([0x3a9, 0x6f22]);
    const text = latin1(writePdf(layout, { ...options, fonts }));
    expect(text).toContain(
      "6 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+DejaVuSans /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 10 0 R >>",
    );
    expect(text).toContain("/CIDToGIDMap /Identity");
    expect(text).toContain("/W [1 [765]]");
    expect(text).toContain("/W [1 [1000] 2 [1000]]");
    expect(text).toContain("<< /Length1 100 /Filter /FlateDecode /Length 5 >>\nstream\nFONT0");
    expect(text).toContain("/FontFile2 9 0 R");
    expect(text).toContain("<0001> <03A9>");
    expect(text).toContain("<0001> <D842DFB7>");
    expect(text).toContain("/Font << /F1 3 0 R /F2 4 0 R /F3 6 0 R /F4 11 0 R >>");
    const runs = textRuns("Ab Ω漢", 10);
    const y = text.match(/1 0 0 1 38 ([\d.]+) Tm \(Ab \) Tj/)?.[1];
    expect(text).toContain(
      `BT\n/F1 10 Tf 0 g\n1 0 0 1 38 ${y} Tm (Ab ) Tj\n/F3 10 Tf\n1 0 0 1 ${num(38 + runs[1].dx)} ${y} Tm <0001> Tj\n` +
        `/F4 10 Tf\n1 0 0 1 ${num(38 + runs[2].dx)} ${y} Tm <0002> Tj\nET`,
    );
    const second = writePdf(layout, { ...options, fonts });
    expect(latin1(second)).toBe(text);
  });

  it("strokes bold fallback runs and prints ? without a subset", () => {
    const bold = latin1(writePdf(doc("Ω", true), { ...options, fonts }));
    expect(bold).toMatch(/\n0 G 0\.3 w 2 Tr 1 0 0 1 38 [\d.]+ Tm <0001> Tj 0 Tr\n/);
    const plain = latin1(writePdf(doc("Ω"), options));
    expect(plain).toContain("(?) Tj");
    expect(plain).not.toContain("Type0");
  });

  it("leaves WinAnsi-only reports byte-identical", () => {
    const layout = doc("Café");
    expect(fallbackCodePoints(layout)).toEqual([]);
    expect(latin1(writePdf(layout, { ...options, fonts: [] }))).toBe(
      latin1(writePdf(layout, options)),
    );
  });
});

describe("pdf alpha images", () => {
  const image: ReportDocument = {
    width: 200,
    height: 100,
    diagnostics: [],
    pages: [
      {
        number: 1,
        items: [
          {
            kind: "image",
            componentId: "i",
            x: 0,
            y: 0,
            w: 30,
            h: 20,
            assetId: "logo",
            mediaType: "image/png",
          },
        ],
      },
    ],
  };

  it("writes decoded PNGs with an SMask", () => {
    const decoded = {
      width: 2,
      height: 1,
      colors: 3 as const,
      colorBase64: btoa("RGB"),
      alphaBase64: btoa("A"),
    };
    const text = latin1(writePdf(image, { ...options, decodedImages: { logo: decoded } }));
    expect(text).toContain(
      "6 0 obj\n<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 7 0 R /Length 3 >>\nstream\nRGB",
    );
    expect(text).toContain(
      "7 0 obj\n<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length 1 >>\nstream\nA",
    );
    expect(text).toContain("/XObject << /Im1 6 0 R >>");
    expect(text).toContain("/Count 1");
    expect(text).toContain("8 0 obj\n<< /Type /Page");
    expect(text).toContain("q 30 0 0 20 0 80 cm /Im1 Do Q");
    const opaque = decodedImage({ ...decoded, colors: 1, alphaBase64: null }, (s) =>
      Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
    );
    expect(opaque.smask).toBeUndefined();
    expect(opaque.dict).toContain("/DeviceGray");
  });

  it("sends PNGs with tRNS transparency to Rust instead of passing them through", () => {
    const chunk = (type: string, body: number[]) => [
      0,
      0,
      0,
      body.length,
      ...Array.from(type, (c) => c.charCodeAt(0)),
      ...body,
      0,
      0,
      0,
      0,
    ];
    const png = (extra: number[]) =>
      new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 3, 0, 0, 0]),
        ...chunk("PLTE", [1, 2, 3]),
        ...extra,
        ...chunk("IDAT", [1]),
        ...chunk("IEND", []),
      ]);
    expect(pngImage(png([]))).not.toBeNull();
    expect(pngImage(png(chunk("tRNS", [0])))).toBeNull();
  });
});
