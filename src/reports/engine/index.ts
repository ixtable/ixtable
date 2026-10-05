/** Deterministic report layout engine (pure TS, no DOM). See docs/decisions/report-engine.md. */
export * from "./document";
export { compareKeys, layoutReport, PAGE_BAND_TABLE } from "./layout";
export { GROW_WITH_TABLE } from "./grow";
export {
  BASELINE,
  fallbackGlyph,
  LINE_HEIGHT,
  measureText,
  normalizeText,
  type TextRun,
  textRuns,
  winAnsiCode,
  wrapText,
} from "./text";
