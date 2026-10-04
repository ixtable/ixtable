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

/**
 * Text as the report engine prints it: tabs become spaces, line breaks become
 * `\n`, other control characters are dropped and characters the standard PDF
 * fonts can't show become `?`. On-screen preview and PDF use the same text.
 */
export function normalizeText(text: string): string {
  let out = "";
  for (const char of text.replace(/\r\n?/g, "\n").replace(/\t/g, " ")) {
    if (char === "\n") out += char;
    else if (char < " " || char === "\u007f") continue;
    else out += winAnsiCode(char) === QUESTION ? "?" : char;
  }
  return out;
}

/** Width of `text` (already normalized) in points. */
export function measureText(text: string, fontSize: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (const char of text) units += table[winAnsiCode(char) - 32] ?? 0;
  return (units * fontSize) / 1000;
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
