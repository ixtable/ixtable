import type { NamedRegion, Placement } from "./types";

/** Region renames from one edit: old name -> new name. */
export type RegionRenames = Record<string, string>;

const whole = (value: number, low: number, high: number) =>
  Math.min(Math.max(low, Math.round(Number.isFinite(value) ? value : low)), Math.max(low, high));

/** Keeps a region inside a grid with `columns` base columns (1-based, positive spans). */
export const clampRegion = (region: NamedRegion, columns: number): NamedRegion => {
  const count = Math.max(1, columns);
  const column = whole(region.column, 1, count);
  return {
    ...region,
    column,
    row: whole(region.row, 1, 65535),
    columnSpan: whole(region.columnSpan, 1, count - column + 1),
    rowSpan: whole(region.rowSpan, 1, 65535),
  };
};

export const clampRegions = (regions: NamedRegion[], columns: number) =>
  regions.map((region) => clampRegion(region, columns));

/**
 * Follows a placement's region through renames; a region that no longer exists is cleared
 * so the item falls back to its column and row placement.
 */
export function remapRegion(
  placement: Placement,
  regions: NamedRegion[],
  renames: RegionRenames = {},
): Placement {
  if (!placement.region) return placement;
  const name = renames[placement.region] ?? placement.region;
  if (regions.some((r) => r.name === name))
    return name === placement.region ? placement : { ...placement, region: name };
  return { ...placement, region: null };
}

/** Why `name` cannot name region `index` ("" when it can). */
export function regionNameProblem(regions: NamedRegion[], index: number, name: string): string {
  if (!name.trim()) return "Region name is required.";
  if (name !== name.trim()) return "Region name cannot start or end with spaces.";
  if (regions.some((r, i) => i !== index && r.name === name))
    return `Another region is already named ${name}.`;
  return "";
}
