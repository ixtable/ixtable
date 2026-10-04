import { describe, expect, it } from "vitest";
import type { ReportDocument } from "../../src/reports/engine";
import { layoutReport } from "../../src/reports/engine";
import { num, pdfDate, pdfString, toBase64, writePdf } from "../../src/reports/pdf";
import { jpegImage, pngImage } from "../../src/reports/pdf-images";
import { band, baseReport, orders } from "./report-fixtures";

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");

function checkStructure(bytes: Uint8Array) {
  const text = latin1(bytes);
  const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF\n$/)?.[1]);
  expect(text.slice(startxref, startxref + 5)).toBe("xref\n");
  const [, count] = text.slice(startxref).match(/^xref\n0 (\d+)\n/) ?? [];
  const entries = text
    .slice(startxref)
    .split("\n")
    .slice(2, 2 + Number(count));
  expect(entries[0]).toBe("0000000000 65535 f ");
  entries.slice(1).forEach((entry, i) => {
    expect(entry).toMatch(/^\d{10} 00000 n $/);
    const offset = Number(entry.slice(0, 10));
    expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
  });
  for (const match of text.matchAll(/<< (?:[^\n]*?)\/Length (\d+) >>\nstream\n/g)) {
    const start = (match.index ?? 0) + match[0].length;
    expect(text.slice(start + Number(match[1]), start + Number(match[1]) + 10)).toBe("\nendstream");
  }
  return text;
}

const tiny: ReportDocument = {
  width: 200,
  height: 100,
  diagnostics: [],
  pages: [
    {
      number: 1,
      items: [
        {
          kind: "rect",
          componentId: "r",
          x: 10,
          y: 10,
          w: 50,
          h: 20,
          lineWidth: 1,
          gray: 0,
          fill: 0.9,
        },
        { kind: "line", componentId: "l", x: 10, y: 40, w: 100, h: 0, lineWidth: 0.5, gray: 0.25 },
        {
          kind: "text",
          componentId: "t",
          x: 10,
          y: 50,
          w: 100,
          h: 14,
          text: "Café (1)",
          lines: [{ text: "Café (1)", x: 12, y: 58.56, width: 36.13 }],
          fontSize: 10,
          bold: true,
          gray: 0,
        },
      ],
    },
  ],
};

describe("pdf writer", () => {
  it("formats numbers, strings and dates", () => {
    expect([num(1), num(-0.001), num(12.345), num(0.1 + 0.2), num(100)]).toEqual([
      "1",
      "0",
      "12.35",
      "0.3",
      "100",
    ]);
    expect(pdfString("a(b)\\c é €—✓")).toBe("(a\\(b\\)\\\\c \\351 \\200\\227?)");
    expect(pdfDate("2026-01-05T09:08:07.000Z")).toBe("D:20260105090807Z");
  });

  it("writes a byte-for-byte golden PDF 1.4 file", () => {
    const bytes = writePdf(tiny, { title: "Tiny", creationDate: "2026-01-05T00:00:00Z" });
    const content = [
      "q",
      "0.9 g",
      "0 G 1 w",
      "10 70 50 20 re B",
      "Q",
      "q 0.25 G 0.5 w 10 60 m 110 60 l S Q",
      "BT",
      "/F2 10 Tf 0 g",
      "1 0 0 1 12 41.44 Tm (Caf\\351 \\(1\\)) Tj",
      "ET",
    ].join("\n");
    const objects = [
      "%PDF-1.4\n%âãÏÓ\n",
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [6 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n",
      "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n",
      "5 0 obj\n<< /Title (Tiny) /Producer (ixtable report engine) /CreationDate (D:20260105000000Z) >>\nendobj\n",
      "6 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents 7 0 R >>\nendobj\n",
      `7 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    ];
    const offsets = objects.map((_, i) => objects.slice(0, i).join("").length);
    const xref = objects.join("").length;
    const expected =
      objects.join("") +
      "xref\n0 8\n0000000000 65535 f \n" +
      offsets
        .slice(1)
        .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
        .join("") +
      `trailer\n<< /Size 8 /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    expect(latin1(bytes)).toBe(expected);
    checkStructure(bytes);
  });

  it("is deterministic for a multi-page report and keeps xref offsets valid", () => {
    const report = baseReport({
      detail: band(300, [
        {
          id: "n",
          kind: "field",
          expression: "record.customer & ' (€)'",
          x: 0,
          y: 0,
          w: 100,
          h: 14,
        },
      ]),
      pageFooter: band(20, [
        {
          id: "p",
          kind: "calculated",
          expression: "page & '/' & pages",
          x: 0,
          y: 0,
          w: 100,
          h: 14,
        },
      ]),
    });
    const doc = layoutReport(report, orders);
    const options = { title: "Sales", creationDate: "2026-02-01T10:00:00Z" };
    const a = writePdf(doc, options);
    const b = writePdf(layoutReport(report, orders), options);
    expect(a).toEqual(b);
    const text = checkStructure(a);
    expect(text).toContain("/Count 3");
    expect(text).toContain("(Elm \\(\\200\\)) Tj");
    expect(text).toContain("(3/3) Tj");
    const later = writePdf(doc, { ...options, creationDate: "2026-02-02T10:00:00Z" });
    expect(latin1(later).replace("D:20260202", "D:20260201")).toBe(text);
  });

  it("passes JPEG through as DCTDecode and draws placeholders for unsupported images", () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 1, 0x11, 0, 2, 0x11,
      0, 3, 0x11, 0, 0xff, 0xd9,
    ]);
    expect(jpegImage(jpeg)?.dict).toBe(
      "/Width 3 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
    );
    const doc: ReportDocument = {
      ...tiny,
      pages: [
        {
          number: 1,
          items: [
            {
              kind: "image",
              componentId: "a",
              x: 0,
              y: 0,
              w: 30,
              h: 20,
              assetId: "jpg",
              mediaType: "image/jpeg",
            },
            {
              kind: "image",
              componentId: "b",
              x: 40,
              y: 0,
              w: 30,
              h: 20,
              assetId: "bad",
              mediaType: "image/png",
            },
            {
              kind: "image",
              componentId: "c",
              x: 80,
              y: 0,
              w: 30,
              h: 20,
              assetId: "jpg",
              mediaType: "image/jpeg",
            },
          ],
        },
      ],
    };
    const bytes = writePdf(doc, {
      creationDate: "2026-01-01T00:00:00Z",
      assets: {
        jpg: { mediaType: "image/jpeg", data: jpeg },
        bad: { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) },
      },
    });
    const text = checkStructure(bytes);
    expect(text).toContain(
      "6 0 obj\n<< /Type /XObject /Subtype /Image /Width 3 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length 23 >>\nstream\n",
    );
    expect(text).toContain("/XObject << /Im1 6 0 R >>");
    expect(text).toContain("q 30 0 0 20 0 80 cm /Im1 Do Q");
    expect(text).toContain("q 30 0 0 20 80 80 cm /Im1 Do Q");
    expect(text).toContain("q 0.5 G 0.5 w 40 80 30 20 re S 40 80 m 70 100 l 40 100 m 70 80 l S Q");
  });

  it("passes non-alpha PNG data through with the PNG predictor and rejects alpha PNGs", () => {
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
    const png = (colorType: number) =>
      new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...chunk("IHDR", [0, 0, 0, 4, 0, 0, 0, 5, 8, colorType, 0, 0, 0]),
        ...chunk("IDAT", [1, 2]),
        ...chunk("IDAT", [3]),
        ...chunk("IEND", []),
      ]);
    const rgb = pngImage(png(2));
    expect(rgb?.dict).toBe(
      "/Width 4 /Height 5 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns 4 >>",
    );
    expect([...(rgb?.data ?? [])]).toEqual([1, 2, 3]);
    expect(pngImage(png(6))).toBeNull();
  });

  it("encodes bytes as base64 for the Rust write command", () => {
    expect(toBase64(new Uint8Array([37, 80, 68, 70, 255]))).toBe("JVBERv8=");
  });
});
