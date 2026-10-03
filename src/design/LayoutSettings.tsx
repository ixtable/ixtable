import { Plus, Trash2 } from "lucide-react";
import type { GridLayout } from "../grid/types";
import { withColumnCount } from "./operations";

const num = (value: string, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
};

/** Grid settings: base column tracks, gaps, padding, and breakpoints (column count per width). */
export function LayoutSettings({
  layout,
  onChange,
  title = "Grid",
}: {
  layout: GridLayout;
  onChange: (layout: GridLayout) => void;
  title?: string;
}) {
  return (
    <fieldset className="fd-fieldset">
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
                      ? {
                          ...b,
                          columns: withColumnCount(layout, num(e.target.value, 1) || 1).columns,
                        }
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
            breakpoints: [
              ...layout.breakpoints,
              { minWidth: 960, columns: withColumnCount(layout, layout.columns.length).columns },
            ],
          })
        }
      >
        <Plus aria-hidden="true" />
        Add breakpoint
      </button>
    </fieldset>
  );
}
