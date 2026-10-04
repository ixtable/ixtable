/** Axis scales and tick generation for dashboard charts. Pure functions; no DOM. */

export type Ticks = { min: number; max: number; step: number; ticks: number[] };

/** Decimal places needed to print multiples of `step` exactly. */
export const stepDecimals = (step: number) =>
  step >= 1 || step <= 0 ? 0 : Math.max(0, -Math.floor(Math.log10(step) + 1e-9));

const roundTo = (value: number, decimals: number) => {
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** The 1, 2, 5 × 10^k step closest to splitting `span` into `count` intervals. */
export function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, Math.round(count));
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  // Tolerance absorbs float noise such as (1.04 - 1.01) / 3 = 0.010000000000000009.
  const normalized = raw / magnitude - 1e-9;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

/**
 * Round axis bounds and evenly spaced ticks covering [min, max] with about `count`
 * intervals. Steps are 1, 2 or 5 × 10^k; bounds are multiples of the step. A zero-width
 * range is widened to include zero (or [0, 1] when the value is zero).
 */
export function niceTicks(min: number, max: number, count = 5): Ticks {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : lo;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    if (lo > 0) lo = 0;
    else if (hi < 0) hi = 0;
    else hi = 1;
  }
  const step = niceStep(hi - lo, count);
  const decimals = stepDecimals(step);
  const first = Math.floor(roundTo(lo / step, 9)) * step;
  const last = Math.ceil(roundTo(hi / step, 9)) * step;
  const n = Math.round((last - first) / step);
  const ticks = Array.from({ length: n + 1 }, (_, i) => roundTo(first + i * step, decimals));
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

/** Maps a value in `domain` linearly onto `range`. A zero-width domain maps to the range start. */
export const linearScale =
  ([d0, d1]: [number, number], [r0, r1]: [number, number]) =>
  (value: number) =>
    d1 === d0 ? r0 : r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);

/** Evenly divides `[start, end]` into `count` bands; returns each band's start and the band width. */
export function bandScale(count: number, [start, end]: [number, number]) {
  const width = count > 0 ? (end - start) / count : 0;
  return {
    width,
    start: (index: number) => start + index * width,
    center: (index: number) => start + (index + 0.5) * width,
  };
}

/** Rounds to 2 decimals for SVG output, so rendered paths are short and deterministic. */
export const r2 = (value: number) => roundTo(value, 2);
