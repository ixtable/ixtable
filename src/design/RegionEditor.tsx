import { Plus, Trash2 } from "lucide-react";
import { clampRegion, type RegionRenames, regionNameProblem } from "../grid/regions";
import type { GridLayout, NamedRegion, Placement } from "../grid/types";
import { DraftInput } from "./DraftInput";

/** A name not used by any region yet ("region1", "region2", ...). */
const freshName = (regions: NamedRegion[]) => {
  let n = regions.length + 1;
  while (regions.some((r) => r.name === `region${n}`)) n += 1;
  return `region${n}`;
};

type NumberKey = Exclude<keyof NamedRegion, "name">;

/**
 * Editor for a layout's named regions (name, column, row, spans). Positions are kept inside
 * the grid; a name is applied on blur or Enter only when it is non-empty and unique, and a
 * rename is reported in `renames` so items placed in the region follow it.
 */
export function RegionEditor({
  layout,
  onChange,
}: {
  layout: GridLayout;
  onChange: (regions: NamedRegion[], renames?: RegionRenames) => void;
}) {
  const regions = layout.namedRegions;
  const columns = layout.columns.length;
  const set = (index: number, patch: Partial<NamedRegion>, renames?: RegionRenames) =>
    onChange(
      regions.map((r, i) => (i === index ? clampRegion({ ...r, ...patch }, columns) : r)),
      renames,
    );
  const field = (index: number, key: NumberKey, label: string) => (
    <label>
      {label}
      <DraftInput
        type="number"
        min={1}
        aria-label={`Region ${index + 1} ${label.toLowerCase()}`}
        value={String(regions[index][key])}
        onCommit={(text) => {
          const parsed = Number(text);
          if (text.trim() === "" || !Number.isFinite(parsed)) return "Enter a whole number.";
          set(index, { [key]: parsed });
          return "";
        }}
      />
    </label>
  );
  return (
    <div className="fd-regions" role="group" aria-label="Named regions">
      {regions.map((region, index) => (
        <div className="fd-region" key={index}>
          <div className="fd-row">
            <label>
              Name
              <DraftInput
                aria-label={`Region ${index + 1} name`}
                value={region.name}
                onCommit={(name) => {
                  const problem = regionNameProblem(regions, index, name);
                  if (!problem) set(index, { name }, { [region.name]: name });
                  return problem;
                }}
              />
            </label>
            <button
              type="button"
              aria-label={`Remove region ${index + 1}`}
              onClick={() => onChange(regions.filter((_, i) => i !== index))}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>
          <div className="fd-row">
            {field(index, "column", "Column")}
            {field(index, "row", "Row")}
          </div>
          <div className="fd-row">
            {field(index, "columnSpan", "Column span")}
            {field(index, "rowSpan", "Row span")}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange([
            ...regions,
            { name: freshName(regions), column: 1, row: 1, columnSpan: columns, rowSpan: 1 },
          ])
        }
      >
        <Plus aria-hidden="true" />
        Add region
      </button>
    </div>
  );
}

/** Region picker for an item's placement: "None" keeps the column and row placement. */
export function RegionPicker({
  layout,
  placement,
  onChange,
}: {
  layout: GridLayout;
  placement: Placement;
  onChange: (placement: Placement) => void;
}) {
  const names = layout.namedRegions.map((r) => r.name).filter(Boolean);
  const current = placement.region ?? "";
  if (!names.length && !current) return null;
  return (
    <label>
      Region
      <select
        value={current}
        onChange={(e) => onChange({ ...placement, region: e.target.value || null })}
      >
        <option value="">None (use column and row)</option>
        {current && !names.includes(current) && (
          <option value={current}>{current} (missing)</option>
        )}
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
