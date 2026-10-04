import type { BandEntry } from "../model";
import type { ReportComponent } from "../types";

export type Geometry = Pick<ReportComponent, "x" | "y" | "w" | "h">;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Keeps a component inside its band and at least 1pt in size. */
export function clampGeometry(g: Geometry, width: number, height: number): Geometry {
  const w = clamp(Math.round(g.w), 1, width);
  const h = clamp(Math.round(g.h), 1, Math.max(1, height));
  return {
    w,
    h,
    x: clamp(Math.round(g.x), 0, width - w),
    y: clamp(Math.round(g.y), 0, Math.max(0, height - h)),
  };
}

export const bandMinHeight = (entry: BandEntry) =>
  Math.max(0, ...entry.band.components.map((c) => c.y + c.h));
