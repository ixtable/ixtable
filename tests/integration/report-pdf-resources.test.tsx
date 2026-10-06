import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { layoutReport } from "../../src/reports/engine";
import { reportPdfBytes } from "../../src/reports/export";
import { newReport } from "../../src/reports/model";
import { renderNewDocument } from "./helpers";

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

function png(ihdr: number[], pixels: number[]): string {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), body])));
    return Buffer.concat([head, Buffer.from(type), body, tail]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", Buffer.from(ihdr)),
    chunk("IDAT", deflateSync(Buffer.from(pixels))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const rgbaPng = () =>
  png([0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0], [0, 255, 0, 0, 255, 0, 255, 0, 128]);

it("exports Greek, Cyrillic and CJK text with embedded font subsets and PNG alpha as an SMask", async () => {
  await renderNewDocument();
  const report = newReport("Unicode");
  report.bands.detail.components = [
    { id: "t", kind: "staticText", text: "Ωμέγα Жук 漢字 ✓", x: 0, y: 0, w: 300, h: 16 },
    { id: "i", kind: "image", assetId: "logo", x: 0, y: 20, w: 40, h: 20 },
  ];
  report.bands.detail.height = 40;
  const assets = { logo: { mediaType: "image/png", dataBase64: rgbaPng() } };
  const doc = layoutReport(report, [{}], {
    now: new Date("2026-01-01T00:00:00Z"),
    assets: { logo: { mediaType: "image/png" } },
  });
  const options = { title: "Unicode", creationDate: "2026-01-01T00:00:00Z" };
  const { bytes, warnings } = await reportPdfBytes(doc, assets, options);
  expect(warnings).toEqual([]);
  const text = latin1(bytes);
  expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+DejaVuSans \/Encoding \/Identity-H/);
  expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+DroidSansFallback \/Encoding \/Identity-H/);
  expect(text.match(/\/FontFile2 \d+ 0 R/g)).toHaveLength(2);
  expect(text).toContain("<03A9>");
  expect(text).toContain("<6F22>");
  expect(text).not.toContain("(?");
  expect(text).toMatch(
    /\/Width 2 \/Height 1 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/FlateDecode \/SMask \d+ 0 R/,
  );
  expect(text).toContain("/Im1 Do");
  expect(latin1((await reportPdfBytes(doc, assets, options)).bytes)).toBe(text);
}, 60_000);

it("prints an oversized PNG as a placeholder with a warning instead of allocating it", async () => {
  await renderNewDocument();
  const report = newReport("Huge");
  report.bands.detail.components = [
    { id: "i", kind: "image", assetId: "huge", x: 0, y: 0, w: 40, h: 20 },
  ];
  const huge = png([0, 0, 0x9c, 0x40, 0, 0, 0x9c, 0x40, 8, 6, 0, 0, 0], [0]);
  const doc = layoutReport(report, [{}], { assets: { huge: { mediaType: "image/png" } } });
  const { bytes, warnings } = await reportPdfBytes(
    doc,
    { huge: { mediaType: "image/png", dataBase64: huge } },
    { creationDate: "2026-01-01T00:00:00Z" },
  );
  expect(warnings).toEqual(["Image 1: PNG is 40000×40000, larger than the 50 megapixel limit"]);
  const text = latin1(bytes);
  expect(text).not.toContain("/Subtype /Image");
  expect(text).toMatch(/ re S .* m .* l .* m .* l S Q/);
}, 60_000);
