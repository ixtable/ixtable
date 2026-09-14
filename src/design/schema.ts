import type { CSSProperties } from "react";

export const DESIGN_SCHEMA_VERSION = 2;
export type ControlKind = "text" | "number" | "select" | "checkbox" | "section";
export type TrackKind = "fixed" | "content" | "fr";
export type GridTrack = {
  kind: TrackKind;
  value?: number | null;
  min?: number | null;
  max?: number | null;
};
export type GridLayout = {
  columns: GridTrack[];
  rows: GridTrack[];
  columnGap: number;
  rowGap: number;
  padding: number;
  justifyItems: "stretch" | "start" | "center" | "end";
  alignItems: "stretch" | "start" | "center" | "end";
  namedRegions: Array<{
    name: string;
    column: number;
    row: number;
    columnSpan: number;
    rowSpan: number;
  }>;
  breakpoints: Array<{ minWidth: number; columns: GridTrack[] }>;
};
export type Placement = {
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
  region?: string | null;
};
export type DesignControl = {
  id: string;
  kind: ControlKind;
  label: string;
  binding?: { table: string; column: string } | null;
  validation: {
    required: boolean;
    min?: number | null;
    max?: number | null;
    pattern?: string | null;
  };
  placement: Placement;
};
export type DesignForm = {
  id: string;
  name: string;
  table?: string | null;
  controls: DesignControl[];
  layout: GridLayout;
};
export type DesignSchema = {
  version: number;
  forms: DesignForm[];
  navigation: { id: string; label: string; formId: string }[];
};

export const defaultGridLayout = (): GridLayout => ({
  columns: Array.from({ length: 12 }, () => ({ kind: "fr", value: 1 })),
  rows: [],
  columnGap: 16,
  rowGap: 16,
  padding: 0,
  justifyItems: "stretch",
  alignItems: "stretch",
  namedRegions: [],
  breakpoints: [],
});

export const trackCss = (track: GridTrack): string => {
  const size =
    track.kind === "fr"
      ? `${track.value ?? 1}fr`
      : track.kind === "content"
        ? "max-content"
        : `${track.value ?? 0}px`;
  if (track.min == null && track.max == null) return size;
  const min = track.min == null ? "0px" : `${track.min}px`;
  const max = track.max == null ? size : `${track.max}px`;
  return `minmax(${min}, ${max})`;
};

export const layoutStyle = (layout: GridLayout): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: layout.columns.map(trackCss).join(" "),
  gridTemplateRows: layout.rows.length ? layout.rows.map(trackCss).join(" ") : "auto",
  columnGap: layout.columnGap,
  rowGap: layout.rowGap,
  padding: layout.padding,
  justifyItems: layout.justifyItems,
  alignItems: layout.alignItems,
});

export const placementStyle = (placement: Placement): CSSProperties =>
  placement.region
    ? { gridArea: placement.region }
    : {
        gridColumn: `${placement.column} / span ${placement.columnSpan}`,
        gridRow: `${placement.row} / span ${placement.rowSpan}`,
      };

export const nextPlacement = (form: DesignForm): Placement => {
  const used = form.controls.reduce((max, item) => Math.max(max, item.placement.row), 0);
  return { column: 1, row: used + 1, columnSpan: 12, rowSpan: 1, region: null };
};

export const newControl = (kind: ControlKind, form: DesignForm): DesignControl => ({
  id: crypto.randomUUID(),
  kind,
  label: kind === "section" ? "New section" : `New ${kind} field`,
  binding: null,
  validation: { required: false },
  placement: nextPlacement(form),
});
