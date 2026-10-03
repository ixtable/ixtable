import { describe, expect, it } from "vitest";
import {
  barGeometry,
  type Frame,
  lineGeometry,
  pathOf,
  pieGeometry,
  scatterGeometry,
  sparkline,
} from "../../src/dashboards/charts/geometry";
import { SERIES_COLORS } from "../../src/dashboards/charts/palette";
import { bandScale, linearScale, niceStep, niceTicks } from "../../src/dashboards/charts/scale";
const FRAME: Frame = { width: 100, height: 100, margin: { top: 0, right: 0, bottom: 0, left: 0 } };

describe("niceTicks", () => {
  it("rounds bounds out to 1/2/5 steps", () => {
    expect(niceTicks(0, 97, 5)).toEqual({
      min: 0,
      max: 100,
      step: 20,
      ticks: [0, 20, 40, 60, 80, 100],
    });
    expect(niceTicks(-37, 112, 5)).toEqual({
      min: -50,
      max: 150,
      step: 50,
      ticks: [-50, 0, 50, 100, 150],
    });
    expect(niceTicks(3, 7, 4).ticks).toEqual([3, 4, 5, 6, 7]);
    expect(niceTicks(0, 1000, 4).ticks).toEqual([0, 500, 1000]);
  });

  it("prints decimal steps without float noise", () => {
    expect(niceTicks(0.1, 0.87, 4).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0, 0.3, 3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
    expect(niceTicks(1.01, 1.04, 3)).toMatchObject({ min: 1.01, max: 1.04, step: 0.01 });
  });

  it("handles flat, reversed and non-finite input", () => {
    expect(niceTicks(5, 5).ticks).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(-4, -4)).toMatchObject({ min: -4, max: 0 });
    expect(niceTicks(0, 0).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(10, 0)).toEqual(niceTicks(0, 10));
    expect(niceTicks(Number.NaN, Number.POSITIVE_INFINITY).ticks).toEqual([
      0, 0.2, 0.4, 0.6, 0.8, 1,
    ]);
  });

  it("chooses steps and scales", () => {
    expect([niceStep(10, 5), niceStep(14, 5), niceStep(40, 5), niceStep(70, 5)]).toEqual([
      2, 5, 10, 20,
    ]);
    expect(linearScale([0, 10], [100, 0])(2.5)).toBe(75);
    expect(linearScale([3, 3], [10, 20])(3)).toBe(10);
    const band = bandScale(4, [0, 100]);
    expect([band.width, band.start(1), band.center(3)]).toEqual([25, 25, 87.5]);
  });
});

const sales = {
  categories: ["East", "West"],
  series: [
    { name: "2025", values: [40, 10] },
    { name: "2026", values: [20, -10] },
  ],
};

describe("bar geometry", () => {
  it("places grouped bars side by side from the zero line", () => {
    const g = barGeometry(sales, { frame: FRAME });
    expect(g.ticks.ticks).toEqual([-10, 0, 10, 20, 30, 40]);
    expect(g.zeroY).toBe(80);
    expect(g.bars).toEqual([
      { series: 0, category: 0, value: 40, x: 5, y: 0, width: 18, height: 80 },
      { series: 1, category: 0, value: 20, x: 25, y: 40, width: 18, height: 40 },
      { series: 0, category: 1, value: 10, x: 55, y: 60, width: 18, height: 20 },
      { series: 1, category: 1, value: -10, x: 75, y: 80, width: 18, height: 20 },
    ]);
    expect(g.xLabels).toEqual([
      { text: "East", x: 25 },
      { text: "West", x: 75 },
    ]);
  });

  it("stacks positives up and negatives down", () => {
    const g = barGeometry(sales, { frame: FRAME, stacked: true });
    expect(g.ticks.ticks).toEqual([-20, 0, 20, 40, 60]);
    expect(g.bars.map(({ x, y, width, height }) => [x, y, width, height])).toEqual([
      [5, 25, 40, 50],
      [5, 0, 40, 25],
      [55, 62.5, 40, 12.5],
      [55, 75, 40, 12.5],
    ]);
  });

  it("skips null values", () => {
    const g = barGeometry(
      { categories: ["A"], series: [{ name: "v", values: [null] }] },
      { frame: FRAME },
    );
    expect(g.bars).toEqual([]);
    expect(g.ticks.ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});

describe("line and area geometry", () => {
  const data = {
    categories: ["Q1", "Q2", "Q3", "Q4"],
    series: [{ name: "v", values: [10, 30, null, 20] }],
  };

  it("draws lines through category centers and breaks at nulls", () => {
    const g = lineGeometry(data, { frame: FRAME });
    expect(g.ticks.ticks).toEqual([10, 15, 20, 25, 30]);
    expect(g.series[0].path).toBe("M12.5,100L37.5,0M87.5,50");
    expect(g.series[0].points.map((p) => p.value)).toEqual([10, 30, 20]);
    expect(g.series[0].area).toBeUndefined();
  });

  it("fills areas down to zero, one shape per run", () => {
    const g = lineGeometry(data, { frame: FRAME, area: true });
    expect(g.ticks.ticks).toEqual([0, 10, 20, 30]);
    expect(g.zeroY).toBe(100);
    expect(g.series[0].area).toBe("M12.5,66.67L37.5,0L37.5,100L12.5,100ZM87.5,33.33L87.5,100Z");
  });

  it("stacks areas on the series below", () => {
    const g = lineGeometry(
      {
        categories: ["a", "b"],
        series: [
          { name: "x", values: [10, 20] },
          { name: "y", values: [10, 20] },
        ],
      },
      { frame: FRAME, area: true, stacked: true },
    );
    expect(g.ticks.max).toBe(40);
    expect(g.series[1].path).toBe("M25,50L75,0");
    expect(g.series[1].area).toBe("M25,50L75,0L75,50L25,75Z");
  });

  it("joins paths", () => {
    expect(pathOf([{ x: 1, y: 2 }, null, { x: 3.333, y: 4 }, { x: 5, y: 6 }])).toBe(
      "M1,2M3.33,4L5,6",
    );
  });
});

describe("pie and donut geometry", () => {
  it("cuts clockwise slices from 12 o'clock and drops non-positive values", () => {
    const slices = pieGeometry(["A", "B", "C", "D"], [25, 75, 0, null], {
      cx: 50,
      cy: 50,
      radius: 50,
    });
    expect(slices.map((s) => [s.label, s.fraction])).toEqual([
      ["A", 0.25],
      ["B", 0.75],
    ]);
    expect(slices[0].path).toBe("M50,50L50,0A50,50 0 0 1 100,50Z");
    expect(slices[1].path).toBe("M50,50L100,50A50,50 0 1 1 50,0Z");
  });

  it("cuts a hole for donuts", () => {
    const [half] = pieGeometry(["A", "B"], [1, 1], { cx: 50, cy: 50, radius: 50, inner: 0.5 });
    expect(half.path).toBe("M50,0A50,50 0 0 1 50,100L50,75A25,25 0 0 0 50,25Z");
  });

  it("draws a single full slice as two half circles", () => {
    const [full] = pieGeometry(["A"], [3], { cx: 50, cy: 50, radius: 50 });
    expect(full.fraction).toBe(1);
    expect(full.path).toBe("M50,0A50,50 0 1 1 50,100A50,50 0 1 1 50,0Z");
  });
});

describe("scatter and sparkline geometry", () => {
  it("maps points onto nice x and y axes", () => {
    const g = scatterGeometry(
      {
        series: [
          {
            name: "s",
            points: [
              { x: 0, y: 0, label: "0" },
              { x: 8, y: 45, label: "8" },
            ],
          },
        ],
      },
      FRAME,
    );
    expect(g.xTicks.ticks).toEqual([0, 2, 4, 6, 8]);
    expect(g.yTicks.ticks).toEqual([0, 10, 20, 30, 40, 50]);
    expect(g.series[0].points.map(({ cx, cy }) => [cx, cy])).toEqual([
      [0, 100],
      [100, 10],
    ]);
  });

  it("draws a sparkline across the full width", () => {
    expect(sparkline([1, 3, null, 2], { width: 100, height: 20, pad: 0 })).toEqual({
      path: "M0,20L33.33,0M100,10",
      last: { x: 100, y: 10 },
    });
    expect(sparkline([5, 5], { width: 10, height: 10, pad: 0 }).path).toBe("M0,5L10,5");
    expect(sparkline([null], {}).last).toBeNull();
  });
});

describe("palette", () => {
  it("has eight distinct fixed colors with at least 3:1 contrast on white", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect(new Set(SERIES_COLORS).size).toBe(8);
    for (const color of SERIES_COLORS)
      expect(1.05 / (luminance(color) + 0.05)).toBeGreaterThanOrEqual(3);
  });
});
