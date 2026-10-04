import { Plus, Trash2 } from "lucide-react";
import type { GridLayout, NamedRegion, Placement } from "../grid/types";

const whole = (value: string, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.round(parsed) : fallback;
};

/** A name not used by any region yet ("region1", "region2", ...). */
const freshName = (regions: NamedRegion[]) => {
  let n = regions.length + 1;
  while (regions.some((r) => r.name === `region${n}`)) n += 1;
  return `region${n}`;
};

type NumberKey = Exclude<keyof NamedRegion, "name">;

/** Editor for a layout's named regions (name, column, row, spans). */
export function RegionEditor({
  layout,
  onChange,
}: {
  layout: GridLayout;
  onChange: (regions: NamedRegion[]) => void;
}) {
  const regions = layout.namedRegions;
  const set = (index: number, patch: Partial<NamedRegion>) =>
    onChange(regions.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const field = (index: number, key: NumberKey, label: string) => (
    <label>
      {label}
      <input
        type="number"
        min={1}
        aria-label={`Region ${index + 1} ${label.toLowerCase()}`}
        value={regions[index][key]}
        onChange={(e) => set(index, { [key]: whole(e.target.value, regions[index][key]) })}
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
              <input
                aria-label={`Region ${index + 1} name`}
                value={region.name}
                onChange={(e) => set(index, { name: e.target.value })}
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
            {
              name: freshName(regions),
              column: 1,
              row: 1,
              columnSpan: layout.columns.length,
              rowSpan: 1,
            },
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
