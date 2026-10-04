/** Deterministic report layout engine (pure TS, no DOM). See docs/decisions/report-engine.md. */
export * from "./document";
export { compareKeys, layoutReport } from "./layout";
export { BASELINE, LINE_HEIGHT, measureText, normalizeText, winAnsiCode, wrapText } from "./text";
