/**
 * Embedded fallback fonts for the PDF writer. Rust (`prepare_report_pdf`)
 * subsets the bundled Unicode fonts to the characters a report uses; this
 * module writes them as Type0 fonts with Identity-H encoding, a CIDFontType2
 * descendant (CIDToGIDMap Identity), and a ToUnicode CMap for copy and search.
 */

export interface PdfFontGlyph {
  codePoint: number;
  /** Glyph id in the subset, written as the 2-byte character code. */
  cid: number;
  /** Advance in 1/1000 em. */
  width: number;
}

/** One font subset from `prepare_report_pdf`. */
export interface PdfFontSubset {
  /** Fallback font index (FALLBACK_FONTS); written as `/F{index + 3}`. */
  index: number;
  baseFont: string;
  /** zlib-compressed TrueType subset. */
  dataBase64: string;
  length1: number;
  bbox: [number, number, number, number];
  ascent: number;
  descent: number;
  capHeight: number;
  glyphs: PdfFontGlyph[];
}

/** Resource name of a fallback font in content streams. */
export const fallbackFontName = (index: number) => `/F${index + 3}`;

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");

/** UTF-16BE hex of a code point (surrogate pair above the BMP). */
function utf16Hex(cp: number): string {
  if (cp < 0x10000) return hex4(cp);
  const v = cp - 0x10000;
  return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
}

/** Code point to CID of a subset. */
export const cidMap = (font: PdfFontSubset) =>
  new Map(font.glyphs.map((g) => [g.codePoint, g.cid]));

/** Character codes of `text`: one 2-byte CID per character, `.notdef` when missing. */
export function cidString(cids: Map<number, number>, text: string): string {
  let out = "<";
  for (const char of text) out += hex4(cids.get(char.codePointAt(0) ?? 0) ?? 0);
  return `${out}>`;
}

function toUnicode(font: PdfFontSubset): string {
  const glyphs = [...font.glyphs].sort((a, b) => a.cid - b.cid);
  const blocks: string[] = [];
  for (let i = 0; i < glyphs.length; i += 100) {
    const chunk = glyphs.slice(i, i + 100);
    blocks.push(
      `${chunk.length} beginbfchar\n${chunk.map((g) => `<${hex4(g.cid)}> <${utf16Hex(g.codePoint)}>`).join("\n")}\nendbfchar`,
    );
  }
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...blocks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
}

/** Objects a font subset needs, in order, starting at object `first` (5 objects). */
export function fontObjects(
  font: PdfFontSubset,
  first: number,
  fontFile: Uint8Array,
): { body?: string; stream?: { dict: string; data: string | Uint8Array } }[] {
  const [cidFont, descriptor, file, cmap] = [1, 2, 3, 4].map((i) => first + i);
  const widths = [...font.glyphs]
    .sort((a, b) => a.cid - b.cid)
    .map((g) => `${g.cid} [${g.width}]`)
    .join(" ");
  const [x0, y0, x1, y1] = font.bbox;
  return [
    {
      body: `<< /Type /Font /Subtype /Type0 /BaseFont /${font.baseFont} /Encoding /Identity-H /DescendantFonts [${cidFont} 0 R] /ToUnicode ${cmap} 0 R >>`,
    },
    {
      body:
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.baseFont}` +
        " /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>" +
        ` /FontDescriptor ${descriptor} 0 R /DW 1000 /W [${widths}] /CIDToGIDMap /Identity >>`,
    },
    {
      body:
        `<< /Type /FontDescriptor /FontName /${font.baseFont} /Flags 4 /FontBBox [${x0} ${y0} ${x1} ${y1}]` +
        ` /ItalicAngle 0 /Ascent ${font.ascent} /Descent ${font.descent} /CapHeight ${font.capHeight}` +
        ` /StemV 80 /FontFile2 ${file} 0 R >>`,
    },
    { stream: { dict: `/Length1 ${font.length1} /Filter /FlateDecode`, data: fontFile } },
    { stream: { dict: "", data: toUnicode(font) } },
  ];
}
