/**
 * Chart geometry: scales, bar rectangles, line/area paths, pie arcs, scatter points and
 * sparklines in SVG user units. Pure and deterministic (coordinates rounded to 0.01).
 */
import type { CategoryData, ScatterData } from "../data";
import { bandScale, linearScale, niceTicks, r2, type Ticks } from "./scale";

export type Frame = {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
};

export const DEFAULT_FRAME: Frame = {
  width: 480,
  height: 200,
  margin: { top: 10, right: 16, bottom: 28, left: 52 },
};

export const plotArea = (frame: Frame) => ({
  left: frame.margin.left,
  right: frame.width - frame.margin.right,
  top: frame.margin.top,
  bottom: frame.height - frame.margin.bottom,
});

const finite = (values: (number | null)[]) =>
  values.filter((v): v is number => v !== null && Number.isFinite(v));

export type Bar = {
  series: number;
  category: number;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type BarGeometry = { ticks: Ticks; zeroY: number; bars: Bar[]; xLabels: AxisLabel[] };
export type AxisLabel = { text: string; x: number };

const xLabels = (categories: string[], center: (i: number) => number) =>
  categories.map((text, i) => ({ text, x: r2(center(i)) }));

/** Grouped (side by side) or stacked bars. The value axis always includes zero. */
export function barGeometry(
  data: CategoryData,
  { stacked = false, frame = DEFAULT_FRAME }: { stacked?: boolean; frame?: Frame } = {},
): BarGeometry {
  const area = plotArea(frame);
  const n = data.categories.length;
  let lo = 0;
  let hi = 0;
  if (stacked) {
    for (let c = 0; c < n; c++) {
      const values = finite(data.series.map((s) => s.values[c]));
      hi = Math.max(
        hi,
        values.filter((v) => v > 0).reduce((a, b) => a + b, 0),
      );
      lo = Math.min(
        lo,
        values.filter((v) => v < 0).reduce((a, b) => a + b, 0),
      );
    }
  } else {
    const all = finite(data.series.flatMap((s) => s.values));
    hi = Math.max(0, ...all);
    lo = Math.min(0, ...all);
  }
  const ticks = niceTicks(lo, hi);
  const y = linearScale([ticks.min, ticks.max], [area.bottom, area.top]);
  const band = bandScale(n, [area.left, area.right]);
  const inner = band.width * 0.8;
  const seriesCount = Math.max(1, data.series.length);
  const gap = !stacked && seriesCount > 1 ? 2 : 0;
  const barWidth = stacked ? inner : inner / seriesCount;
  const bars: Bar[] = [];
  for (let c = 0; c < n; c++) {
    let up = 0;
    let down = 0;
    data.series.forEach((series, s) => {
      const value = series.values[c];
      if (value === null || !Number.isFinite(value)) return;
      const x = band.start(c) + band.width * 0.1 + (stacked ? 0 : s * barWidth);
      let from = 0;
      let to = value;
      if (stacked) {
        from = value >= 0 ? up : down;
        to = from + value;
        if (value >= 0) up = to;
        else down = to;
      }
      const y0 = y(from);
      const y1 = y(to);
      bars.push({
        series: s,
        category: c,
        value,
        x: r2(x),
        y: r2(Math.min(y0, y1)),
        width: r2(Math.max(1, barWidth - gap)),
        height: r2(Math.abs(y1 - y0)),
      });
    });
  }
  return { ticks, zeroY: r2(y(0)), bars, xLabels: xLabels(data.categories, band.center) };
}

export type LinePoint = { x: number; y: number; value: number; category: number };
export type LineSeries = { points: LinePoint[]; path: string; area?: string };
export type LineGeometry = {
  ticks: Ticks;
  zeroY: number;
  series: LineSeries[];
  xLabels: AxisLabel[];
};

/** Joins points into an SVG path; `null` gaps start a new subpath. */
export function pathOf(points: ({ x: number; y: number } | null)[]): string {
  let out = "";
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    out += `${pen ? "L" : "M"}${r2(p.x)},${r2(p.y)}`;
    pen = true;
  }
  return out;
}

/**
 * Line or area series at category centers. Areas fill down to zero (or to the series
 * below when stacked); a null value breaks the line and the fill.
 */
export function lineGeometry(
  data: CategoryData,
  {
    area = false,
    stacked = false,
    frame = DEFAULT_FRAME,
  }: { area?: boolean; stacked?: boolean; frame?: Frame } = {},
): LineGeometry {
  const plot = plotArea(frame);
  const n = data.categories.length;
  const stack = stacked && area;
  const tops: (number | null)[][] = [];
  const bottoms: (number | null)[][] = [];
  const running = data.categories.map(() => 0);
  for (const series of data.series) {
    if (stack) {
      bottoms.push([...running]);
      tops.push(
        series.values.map((v, i) => {
          running[i] += v ?? 0;
          return running[i];
        }),
      );
    } else {
      bottoms.push(series.values.map(() => 0));
      tops.push(series.values);
    }
  }
  const values = finite(tops.flat());
  const lo = Math.min(...values, ...(area ? [0] : []));
  const hi = Math.max(...values, ...(area ? [0] : []));
  const ticks = values.length ? niceTicks(lo, hi) : niceTicks(0, 1);
  const y = linearScale([ticks.min, ticks.max], [plot.bottom, plot.top]);
  const band = bandScale(n, [plot.left, plot.right]);
  const series = data.series.map((s, si) => {
    const points = s.values.map((value, c) => {
      const top = tops[si][c];
      return value === null || top === null
        ? null
        : { x: r2(band.center(c)), y: r2(y(top)), value, category: c };
    });
    const line: LineSeries = {
      points: points.filter((p): p is LinePoint => p !== null),
      path: pathOf(points),
    };
    if (area) {
      // One closed shape per run of non-null points.
      const runs: LinePoint[][] = [];
      let current: LinePoint[] = [];
      for (const p of points) {
        if (p) current.push(p);
        else if (current.length) {
          runs.push(current);
          current = [];
        }
      }
      if (current.length) runs.push(current);
      line.area = runs
        .map((run) => {
          const base = [...run]
            .reverse()
            .map((p) => ({ x: p.x, y: y(bottoms[si][p.category] ?? 0) }));
          return `${pathOf([...run, ...base])}Z`;
        })
        .join("");
    }
    return line;
  });
  return {
    ticks,
    zeroY: r2(y(Math.min(Math.max(0, ticks.min), ticks.max))),
    series,
    xLabels: xLabels(data.categories, band.center),
  };
}

export type Slice = {
  index: number;
  label: string;
  value: number;
  fraction: number;
  path: string;
};

const polar = (cx: number, cy: number, r: number, angle: number) => ({
  x: r2(cx + r * Math.cos(angle)),
  y: r2(cy + r * Math.sin(angle)),
});

/**
 * Pie or donut slices for positive values, clockwise from 12 o'clock. `inner` is the hole
 * radius as a fraction of the outer radius (0 for a pie).
 */
export function pieGeometry(
  labels: string[],
  values: (number | null)[],
  { cx = 130, cy = 130, radius = 120, inner = 0 } = {},
): Slice[] {
  const kept = values
    .map((value, index) => ({ index, label: labels[index] ?? "", value: value ?? 0 }))
    .filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = kept.reduce((sum, s) => sum + s.value, 0);
  const ri = radius * inner;
  let angle = -Math.PI / 2;
  return kept.map((s) => {
    const fraction = s.value / total;
    const start = angle;
    const end = angle + fraction * 2 * Math.PI;
    angle = end;
    let path: string;
    if (fraction >= 1) {
      // A full circle cannot be one arc: draw two half circles (and the hole for a donut).
      const top = polar(cx, cy, radius, -Math.PI / 2);
      const bottom = polar(cx, cy, radius, Math.PI / 2);
      path = `M${top.x},${top.y}A${radius},${radius} 0 1 1 ${bottom.x},${bottom.y}A${radius},${radius} 0 1 1 ${top.x},${top.y}Z`;
      if (ri > 0) {
        const t = polar(cx, cy, ri, -Math.PI / 2);
        const b = polar(cx, cy, ri, Math.PI / 2);
        path += `M${t.x},${t.y}A${ri},${ri} 0 1 0 ${b.x},${b.y}A${ri},${ri} 0 1 0 ${t.x},${t.y}Z`;
      }
    } else {
      const large = end - start > Math.PI ? 1 : 0;
      const a = polar(cx, cy, radius, start);
      const b = polar(cx, cy, radius, end);
      if (ri > 0) {
        const c = polar(cx, cy, ri, end);
        const d = polar(cx, cy, ri, start);
        path = `M${a.x},${a.y}A${radius},${radius} 0 ${large} 1 ${b.x},${b.y}L${c.x},${c.y}A${r2(ri)},${r2(ri)} 0 ${large} 0 ${d.x},${d.y}Z`;
      } else {
        path = `M${r2(cx)},${r2(cy)}L${a.x},${a.y}A${radius},${radius} 0 ${large} 1 ${b.x},${b.y}Z`;
      }
    }
    return { index: s.index, label: s.label, value: s.value, fraction, path };
  });
}

export type ScatterGeometry = {
  xTicks: Ticks;
  yTicks: Ticks;
  series: { points: { cx: number; cy: number; x: number; y: number; label: string }[] }[];
};

/** Scatter points on nice linear x and y axes. */
export function scatterGeometry(data: ScatterData, frame: Frame = DEFAULT_FRAME): ScatterGeometry {
  const plot = plotArea(frame);
  const all = data.series.flatMap((s) => s.points);
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const xTicks = all.length ? niceTicks(Math.min(...xs), Math.max(...xs)) : niceTicks(0, 1);
  const yTicks = all.length ? niceTicks(Math.min(...ys), Math.max(...ys)) : niceTicks(0, 1);
  const sx = linearScale([xTicks.min, xTicks.max], [plot.left, plot.right]);
  const sy = linearScale([yTicks.min, yTicks.max], [plot.bottom, plot.top]);
  return {
    xTicks,
    yTicks,
    series: data.series.map((s) => ({
      points: s.points.map((p) => ({
        cx: r2(sx(p.x)),
        cy: r2(sy(p.y)),
        x: p.x,
        y: p.y,
        label: p.label,
      })),
    })),
  };
}

/** A sparkline path through the non-null values, scaled to fill `width` × `height`. */
export function sparkline(
  values: (number | null)[],
  { width = 160, height = 40, pad = 3 } = {},
): { path: string; last: { x: number; y: number } | null } {
  const nums = finite(values);
  if (!nums.length) return { path: "", last: null };
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const sx = linearScale([0, Math.max(1, values.length - 1)], [pad, width - pad]);
  const sy = lo === hi ? () => height / 2 : linearScale([lo, hi], [height - pad, pad]);
  const points = values.map((v, i) =>
    v === null || !Number.isFinite(v) ? null : { x: r2(sx(i)), y: r2(sy(v)) },
  );
  const last = [...points].reverse().find((p) => p !== null) ?? null;
  return { path: pathOf(points), last };
}
