/**
 * Categorical series colors, assigned in this fixed order and never cycled (a ninth
 * series folds into "Other"). Validated against the white chart surface with the
 * dataviz palette checker: every slot has at least 3:1 contrast, adjacent slots stay
 * apart for protan, deutan and tritan vision (ΔE ≥ 8.6), and the normal-vision floor
 * holds. The app has no dark theme, so there is no dark set.
 */
export const SERIES_COLORS = [
  "#2a78d6", // blue
  "#c8531f", // orange
  "#0b9466", // aqua
  "#9a6600", // yellow
  "#c2406f", // magenta
  "#008300", // green
  "#4a3aa7", // violet
  "#d03b3b", // red
] as const;

/** Neutral for the folded "Other" series (4.9:1 on white). */
export const OTHER_COLOR = "#6b7079";
export const OTHER_LABEL = "Other";

export const MAX_SERIES = SERIES_COLORS.length;

export const seriesColor = (index: number, name?: string) =>
  name === OTHER_LABEL && index === MAX_SERIES - 1
    ? OTHER_COLOR
    : SERIES_COLORS[Math.min(index, MAX_SERIES - 1)];

/** Chart chrome: ink, muted axis text, gridlines and the axis baseline. */
export const INK = "#2f343a";
export const MUTED = "#5c6169";
export const GRID = "#e4e6e9";
export const AXIS = "#b9bec6";
export const SURFACE = "#ffffff";
