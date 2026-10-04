import { Plus, Trash2 } from "lucide-react";
import { validateLayout } from "../grid/engine";
import type { GridAlign, GridIssue, GridItemRef, GridLayout } from "../grid/types";
import { resizeTracks, withColumnCount } from "./operations";
import { RegionEditor } from "./RegionEditor";
import { TrackList } from "./TrackList";

const num = (value: string, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
};

const ALIGNS: GridAlign[] = ["stretch", "start", "center", "end"];

/**
 * Grid settings shared by the form and dashboard designers: column and row tracks, gaps,
 * padding, item alignment, named regions, and breakpoints. When `items` is given, the
 * problems `validateLayout` finds (the same rules as Rust `design::validate_layout`) are listed.
 */
export function LayoutSettings({
  layout,
  onChange,
  title = "Grid",
  items,
}: {
  layout: GridLayout;
  onChange: (layout: GridLayout) => void;
  title?: string;
  items?: readonly (GridItemRef & { label?: string })[];
}) {
  const issues = items ? validateLayout(layout, items) : [];
  const labelOf = (id: string) => items?.find((item) => item.id === id)?.label ?? id;
  const text = (issue: GridIssue) =>
    issue.objectKind === "item"
      ? `${labelOf(issue.objectId)}: ${issue.message.replace(/^overlaps (.+)$/, (_, other) => `overlaps ${labelOf(other)}`)}`
      : issue.message;
  const align = (key: "justifyItems" | "alignItems", label: string) => (
    <label>
      {label}
      <select
        value={layout[key]}
        onChange={(e) => onChange({ ...layout, [key]: e.target.value as GridAlign })}
      >
        {ALIGNS.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <fieldset className="fd-fieldset" aria-label={title}>
      <legend>{title}</legend>
      <div className="fd-row">
        <label>
          Columns
          <input
            type="number"
            min={1}
            max={24}
            value={layout.columns.length}
            onChange={(e) =>
              onChange(withColumnCount(layout, num(e.target.value, layout.columns.length) || 1))
            }
          />
        </label>
        <label>
          Padding
          <input
            type="number"
            min={0}
            value={layout.padding}
            onChange={(e) => onChange({ ...layout, padding: num(e.target.value, layout.padding) })}
          />
        </label>
      </div>
      <div className="fd-row">
        <label>
          Column gap
          <input
            type="number"
            min={0}
            value={layout.columnGap}
            onChange={(e) =>
              onChange({ ...layout, columnGap: num(e.target.value, layout.columnGap) })
            }
          />
        </label>
        <label>
          Row gap
          <input
            type="number"
            min={0}
            value={layout.rowGap}
            onChange={(e) => onChange({ ...layout, rowGap: num(e.target.value, layout.rowGap) })}
          />
        </label>
      </div>
      <div className="fd-row">
        {align("justifyItems", "Horizontal alignment")}
        {align("alignItems", "Vertical alignment")}
      </div>
      <small>Column tracks</small>
      <TrackList
        name="Column"
        tracks={layout.columns}
        minCount={1}
        onChange={(columns) => onChange({ ...layout, columns })}
      />
      <small>Row tracks</small>
      <p className="fd-hint">Rows without a track size to their content.</p>
      <TrackList
        name="Row"
        tracks={layout.rows}
        onChange={(rows) => onChange({ ...layout, rows })}
      />
      <small>Named regions</small>
      <RegionEditor
        layout={layout}
        onChange={(namedRegions) => onChange({ ...layout, namedRegions })}
      />
      <small>Breakpoints</small>
      <p className="fd-hint">
        Breakpoints change the column count at a minimum width; items wrap to fit.
      </p>
      {layout.breakpoints.map((breakpoint, index) => (
        <div className="fd-row" key={index}>
          <label>
            From width
            <input
              type="number"
              min={0}
              aria-label={`Breakpoint ${index + 1} minimum width`}
              value={breakpoint.minWidth}
              onChange={(e) =>
                onChange({
                  ...layout,
                  breakpoints: layout.breakpoints.map((b, i) =>
                    i === index ? { ...b, minWidth: num(e.target.value, b.minWidth) } : b,
                  ),
                })
              }
            />
          </label>
          <label>
            Columns
            <input
              type="number"
              min={1}
              max={24}
              aria-label={`Breakpoint ${index + 1} columns`}
              value={breakpoint.columns.length}
              onChange={(e) =>
                onChange({
                  ...layout,
                  breakpoints: layout.breakpoints.map((b, i) =>
                    i === index
                      ? { ...b, columns: resizeTracks(b.columns, num(e.target.value, 1) || 1) }
                      : b,
                  ),
                })
              }
            />
          </label>
          <button
            type="button"
            aria-label={`Remove breakpoint ${index + 1}`}
            onClick={() =>
              onChange({ ...layout, breakpoints: layout.breakpoints.filter((_, i) => i !== index) })
            }
          >
            <Trash2 aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          onChange({
            ...layout,
            breakpoints: [...layout.breakpoints, { minWidth: 960, columns: [...layout.columns] }],
          })
        }
      >
        <Plus aria-hidden="true" />
        Add breakpoint
      </button>
      {issues.length > 0 && (
        <ul className="fd-issues" aria-label={`${title} problems`}>
          {issues.map((issue, i) => (
            <li key={i} className={issue.severity}>
              {text(issue)}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
