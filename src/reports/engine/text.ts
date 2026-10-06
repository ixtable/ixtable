import { FALLBACK_RUNS } from "./fallback-metrics";
import { HELVETICA_BOLD_WIDTHS, HELVETICA_WIDTHS } from "./metrics";

/** Unicode code points outside Latin-1 that WinAnsiEncoding maps into 128..159. */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 128,
  0x201a: 130,
  0x0192: 131,
  0x201e: 132,
  0x2026: 133,
  0x2020: 134,
  0x2021: 135,
  0x02c6: 136,
  0x2030: 137,
  0x0160: 138,
  0x2039: 139,
  0x0152: 140,
  0x017d: 142,
  0x2018: 145,
  0x2019: 146,
  0x201c: 147,
  0x201d: 148,
  0x2022: 149,
  0x2013: 150,
  0x2014: 151,
  0x02dc: 152,
  0x2122: 153,
  0x0161: 154,
  0x203a: 155,
  0x0153: 156,
  0x017e: 158,
  0x0178: 159,
};

const QUESTION = 63;

/** WinAnsi byte for one character, or `?` (63) when the character has none. */
export function winAnsiCode(char: string): number {
  const cp = char.codePointAt(0) ?? QUESTION;
  if ((cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255)) return cp;
  return WIN_ANSI_HIGH[cp] ?? QUESTION;
}

/** Parsed FALLBACK_RUNS: run i covers code points starts[i] .. ends[i] - 1. */
let runTable: { starts: number[]; ends: number[]; fonts: number[]; widths: number[] } | null = null;

function fallbackRuns() {
  if (runTable) return runTable;
  const table = {
    starts: [] as number[],
    ends: [] as number[],
    fonts: [] as number[],
    widths: [] as number[],
  };
  let end = 0;
  for (const run of FALLBACK_RUNS.split(" ")) {
    const [gap, length, font, width] = run.split(",").map((v) => Number.parseInt(v, 36));
    table.starts.push(end + gap);
    end += gap + length;
    table.ends.push(end);
    table.fonts.push(font);
    table.widths.push(width);
  }
  runTable = table;
  return table;
}

/**
 * Bundled fallback font (index into FALLBACK_FONTS) and advance width in
 * 1/1000 em for a character outside WinAnsi, or null when no bundled font
 * draws it.
 */
export function fallbackGlyph(char: string): { font: number; width: number } | null {
  const cp = char.codePointAt(0) ?? 0;
  if (winAnsiCode(char) !== QUESTION || cp === QUESTION) return null;
  const { starts, ends, fonts, widths } = fallbackRuns();
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < starts[mid]) hi = mid - 1;
    else if (cp >= ends[mid]) lo = mid + 1;
    else return { font: fonts[mid], width: widths[mid] };
  }
  return null;
}

/** Font a character prints in: -1 for Helvetica, else the fallback font index. */
export const fontOf = (char: string) => fallbackGlyph(char)?.font ?? -1;

/**
 * Text as the report engine prints it: tabs become spaces, line breaks become
 * `\n`, other control characters are dropped and characters neither the
 * standard PDF fonts nor the bundled fallback fonts can show become `?`.
 * On-screen preview and PDF use the same text.
 */
export function normalizeText(text: string): string {
  let out = "";
  for (const char of text.replace(/\r\n?/g, "\n").replace(/\t/g, " ")) {
    if (char === "\n") out += char;
    else if (char < " " || char === "\u007f") continue;
    else out += winAnsiCode(char) === QUESTION && !fallbackGlyph(char) ? "?" : char;
  }
  return out;
}

/** Width of `text` (already normalized) in points. */
export function measureText(text: string, fontSize: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (const char of text)
    units += fallbackGlyph(char)?.width ?? table[winAnsiCode(char) - 32] ?? 0;
  return (units * fontSize) / 1000;
}

export interface TextRun {
  text: string;
  /** -1 for Helvetica, else the fallback font index. */
  font: number;
  /** Offset from the start of the line in points. */
  dx: number;
  width: number;
}

/** Splits a laid-out line into runs of one font each, positioned with the fixed metrics. */
export function textRuns(line: string, fontSize: number, bold = false): TextRun[] {
  const runs: TextRun[] = [];
  let dx = 0;
  for (const char of line) {
    const font = fontOf(char);
    const width = measureText(char, fontSize, bold);
    const last = runs[runs.length - 1];
    if (last && last.font === font) {
      last.text += char;
      last.width += width;
    } else runs.push({ text: char, font, dx, width });
    dx += width;
  }
  return runs;
}

/** Line advance as a multiple of the font size. */
export const LINE_HEIGHT = 1.2;
/** Baseline offset from the top of a line, as a multiple of the font size. */
export const BASELINE = 0.8555;

/**
 * Greedy word wrap with the fixed Helvetica metrics. Explicit `\n` starts a
 * new line; a word wider than `maxWidth` is broken between characters.
 */
export function wrapText(text: string, maxWidth: number, fontSize: number, bold = false): string[] {
  const fits = (s: string) => measureText(s, fontSize, bold) <= maxWidth + 1e-9;
  const lines: string[] = [];
  for (const paragraph of normalizeText(text).split("\n")) {
    let current = "";
    for (const word of paragraph.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (fits(candidate) || (!current && !word)) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = word;
      while (current.length > 1 && !fits(current)) {
        const chars = [...current];
        let n = 1;
        while (n < chars.length && fits(chars.slice(0, n + 1).join(""))) n++;
        lines.push(chars.slice(0, n).join(""));
        current = chars.slice(n).join("");
      }
    }
    lines.push(current);
  }
  return lines;
}
