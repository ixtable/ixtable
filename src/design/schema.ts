import type { CSSProperties } from "react";
import {
  layoutToCss,
  nextPlacement as gridNextPlacement,
  placementToCss,
  trackToCss,
} from "../grid/engine";
import type { GridLayout, GridTrack, Placement } from "../grid/types";

export const DESIGN_SCHEMA_VERSION = 2;
export type ControlKind = "text" | "number" | "select" | "checkbox" | "section";
export type {
  Breakpoint,
  GridAlign,
  GridLayout,
  GridTrack,
  NamedRegion,
  Placement,
  TrackKind,
} from "../grid/types";
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

export { defaultGridLayout } from "../grid/engine";

export const trackCss = (track: GridTrack): string => trackToCss(track);

export const layoutStyle = (layout: GridLayout, width?: number): CSSProperties =>
  layoutToCss(layout, { width });

export const placementStyle = (
  placement: Placement,
  layout?: GridLayout,
  width?: number,
): CSSProperties => placementToCss(placement, layout ?? null, width);

export const nextPlacement = (form: DesignForm): Placement =>
  gridNextPlacement(
    form.layout,
    form.controls.map((control) => control.placement),
  );

export const newControl = (kind: ControlKind, form: DesignForm): DesignControl => ({
  id: crypto.randomUUID(),
  kind,
  label: kind === "section" ? "New section" : `New ${kind} field`,
  binding: null,
  validation: { required: false },
  placement: nextPlacement(form),
});
