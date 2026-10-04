/**
 * Minimal deterministic PDF 1.4 writer for laid-out reports (no dependencies).
 *
 * - Fonts: standard Helvetica / Helvetica-Bold, WinAnsiEncoding (not embedded).
 * - Graphics: text, lines, rectangles in gray levels; JPEG and some PNG images
 *   passed through without decoding (see pdf-images.ts).
 * - Determinism: fixed object order, uncompressed content streams, no random
 *   file id, and the CreationDate comes from the options. Same input, same bytes.
 */
import type { PositionedItem, ReportDocument } from "./engine";
import { winAnsiCode } from "./engine";
import { type PdfImage, pdfImage } from "./pdf-images";

export interface PdfAsset {
  mediaType: string;
  data: Uint8Array;
}

export interface PdfOptions {
  title?: string;
  /** ISO timestamp written as /CreationDate. Required so output is reproducible. */
  creationDate: string;
  assets?: Record<string, PdfAsset>;
}

/** Formats a number for content streams: at most 2 decimals, no exponent, no -0. */
export function num(n: number): string {
  const r = Math.round(n * 100) / 100;
  if (!Number.isFinite(r) || r === 0) return "0";
  const s = r.toFixed(2);
  return s.replace(/\.?0+$/, "");
}

/** A PDF literal string in WinAnsi with `\`, `(`, `)` and non-ASCII bytes escaped. */
export function pdfString(text: string): string {
  let out = "(";
  for (const char of text) {
    const code = winAnsiCode(char);
    if (code === 0x5c || code === 0x28 || code === 0x29) out += `\\${String.fromCharCode(code)}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

/** `D:YYYYMMDDHHmmSSZ` from an ISO timestamp (UTC). */
export function pdfDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "D:19700101000000Z";
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

const ascii = (s: string) => {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
};

function itemOps(item: PositionedItem, pageHeight: number, image: (id: string) => string | null) {
  const y = (v: number) => num(pageHeight - v);
  switch (item.kind) {
    case "rect": {
      const stroke = item.lineWidth > 0;
      const fill = item.fill !== null;
      if (!stroke && !fill) return "";
      const op = stroke && fill ? "B" : stroke ? "S" : "f";
      return [
        "q",
        fill ? `${num(item.fill as number)} g` : "",
        stroke ? `${num(item.gray)} G ${num(item.lineWidth)} w` : "",
        `${num(item.x)} ${y(item.y + item.h)} ${num(item.w)} ${num(item.h)} re ${op}`,
        "Q",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "line":
      return `q ${num(item.gray)} G ${num(item.lineWidth)} w ${num(item.x)} ${y(item.y)} m ${num(item.x + item.w)} ${y(item.y + item.h)} l S Q`;
    case "text": {
      if (!item.lines.length) return "";
      const font = item.bold ? "/F2" : "/F1";
      const lines = item.lines.map(
        (line) => `1 0 0 1 ${num(line.x)} ${y(line.y)} Tm ${pdfString(line.text)} Tj`,
      );
      return ["BT", `${font} ${num(item.fontSize)} Tf ${num(item.gray)} g`, ...lines, "ET"].join(
        "\n",
      );
    }
    case "image": {
      const name = image(item.assetId);
      if (name)
        return `q ${num(item.w)} 0 0 ${num(item.h)} ${num(item.x)} ${y(item.y + item.h)} cm ${name} Do Q`;
      // Unsupported or missing image data: a crossed placeholder box.
      const x0 = num(item.x);
      const x1 = num(item.x + item.w);
      const y0 = y(item.y + item.h);
      const y1 = y(item.y);
      return `q 0.5 G 0.5 w ${x0} ${y0} ${num(item.w)} ${num(item.h)} re S ${x0} ${y0} m ${x1} ${y1} l ${x0} ${y1} m ${x1} ${y0} l S Q`;
    }
  }
}

/** Serializes a laid-out report to PDF 1.4 bytes. */
export function writePdf(doc: ReportDocument, options: PdfOptions): Uint8Array {
  // Object numbers: 1 catalog, 2 pages, 3-4 fonts, 5 info, then images, then page/content pairs.
  const images: { id: string; name: string; image: PdfImage }[] = [];
  const imageNames = new Map<string, string | null>();
  for (const page of doc.pages)
    for (const item of page.items) {
      if (item.kind !== "image" || imageNames.has(item.assetId)) continue;
      const asset = options.assets?.[item.assetId];
      const image = asset ? pdfImage(asset.mediaType, asset.data) : null;
      if (!image) {
        imageNames.set(item.assetId, null);
        continue;
      }
      const name = `/Im${images.length + 1}`;
      imageNames.set(item.assetId, name);
      images.push({ id: item.assetId, name, image });
    }
  const firstImage = 6;
  const firstPage = firstImage + images.length;
  const pageRef = (i: number) => firstPage + i * 2;

  const chunks: Uint8Array[] = [];
  let length = 0;
  const offsets: number[] = [];
  const write = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? ascii(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: string) => {
    offsets[n] = length;
    write(`${n} 0 obj\n${body}\nendobj\n`);
  };
  const stream = (n: number, dict: string, data: Uint8Array) => {
    offsets[n] = length;
    write(`${n} 0 obj\n<< ${dict ? `${dict} ` : ""}/Length ${data.length} >>\nstream\n`);
    write(data);
    write("\nendstream\nendobj\n");
  };

  write("%PDF-1.4\n%âãÏÓ\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const kids = doc.pages.map((_, i) => `${pageRef(i)} 0 R`).join(" ");
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${doc.pages.length} >>`);
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  object(
    4,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );
  const title = options.title ? ` /Title ${pdfString(options.title)}` : "";
  object(
    5,
    `<<${title} /Producer (ixtable report engine) /CreationDate (${pdfDate(options.creationDate)}) >>`,
  );
  images.forEach((img, i) =>
    stream(firstImage + i, `/Type /XObject /Subtype /Image ${img.image.dict}`, img.image.data),
  );
  const xobjects = images.length
    ? ` /XObject << ${images.map((img, i) => `${img.name} ${firstImage + i} 0 R`).join(" ")} >>`
    : "";
  doc.pages.forEach((page, i) => {
    const n = pageRef(i);
    object(
      n,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(doc.width)} ${num(doc.height)}]` +
        ` /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects} >> /Contents ${n + 1} 0 R >>`,
    );
    const content = page.items
      .map((item) => itemOps(item, doc.height, (id) => imageNames.get(id) ?? null))
      .filter(Boolean)
      .join("\n");
    stream(n + 1, "", ascii(content));
  });

  const size = firstPage + doc.pages.length * 2;
  const xref = length;
  write(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let n = 1; n < size; n++) write(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  write(`trailer\n<< /Size ${size} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Base64 for passing PDF bytes to Rust. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
