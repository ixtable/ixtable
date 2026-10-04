import { Plus, Trash2 } from "lucide-react";
import type { DbObject } from "../../lib/types";
import type { SavedQuery } from "../../query/types";
import { fieldExpression, groupLabel, newGroup } from "../model";
import type { Band, Orientation, PageSize, Report } from "../types";
import { ExpressionInput, PointInput } from "./fields";

type Change = (fn: (report: Report) => Report, label?: string) => void;

/** Dataset picker value: `query:<id>`, `table:<name>`, or "" for none. */
const datasetValue = (r: Report) =>
  r.datasetQueryId ? `query:${r.datasetQueryId}` : r.table ? `table:${r.table}` : "";

export function DatasetPicker({
  report,
  queries,
  objects,
  change,
}: {
  report: Report;
  queries: SavedQuery[];
  objects: DbObject[];
  change: Change;
}) {
  return (
    <label>
      Dataset
      <select
        value={datasetValue(report)}
        onChange={(e) => {
          const [kind, ...rest] = e.target.value.split(":");
          const id = rest.join(":");
          change(
            (r) => ({
              ...r,
              datasetQueryId: kind === "query" ? id : null,
              table: kind === "table" ? id : null,
            }),
            "Change report dataset",
          );
        }}
      >
        <option value="">No dataset</option>
        {queries.map((q) => (
          <option key={q.id} value={`query:${q.id}`}>
            Query: {q.name}
          </option>
        ))}
        {objects
          .filter((o) => o.objectType === "table" || o.objectType === "view")
          .map((o) => (
            <option key={o.name} value={`table:${o.name}`}>
              Table: {o.name}
            </option>
          ))}
      </select>
    </label>
  );
}

/** Report-level settings: parameters, page setup and groups. */
export function ReportSettings({
  report,
  queries,
  columns,
  change,
}: {
  report: Report;
  queries: SavedQuery[];
  columns: string[];
  change: Change;
}) {
  const page = report.page;
  const query = queries.find((q) => q.id === report.datasetQueryId);
  const setPage = (patch: Partial<Report["page"]>) =>
    change((r) => ({ ...r, page: { ...r.page, ...patch } }), "Page setup");
  const setGroup = (id: string, patch: Partial<Report["bands"]["groups"][number]>) =>
    change(
      (r) => ({
        ...r,
        bands: {
          ...r.bands,
          groups: r.bands.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
        },
      }),
      "Edit group",
    );
  return (
    <>
      {(query?.parameters?.length ?? 0) > 0 && (
        <fieldset>
          <legend>Parameters</legend>
          {query?.parameters?.map((p) => (
            <label key={p.name}>
              Parameter {p.name}
              <input
                value={String(report.params[p.name] ?? p.defaultValue ?? "")}
                onChange={(e) => {
                  const raw = e.target.value;
                  const value = raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
                  change(
                    (r) => ({ ...r, params: { ...r.params, [p.name]: value } }),
                    "Edit parameters",
                  );
                }}
              />
            </label>
          ))}
        </fieldset>
      )}
      <fieldset>
        <legend>Page setup</legend>
        <div className="grid2">
          <label>
            Page size
            <select
              value={page.size}
              onChange={(e) => setPage({ size: e.target.value as PageSize })}
            >
              <option value="A4">A4</option>
              <option value="Letter">Letter</option>
            </select>
          </label>
          <label>
            Orientation
            <select
              value={page.orientation}
              onChange={(e) => setPage({ orientation: e.target.value as Orientation })}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>
          {(["top", "right", "bottom", "left"] as const).map((side) => (
            <PointInput
              key={side}
              label={`${side[0].toUpperCase()}${side.slice(1)} margin`}
              value={page.margins[side]}
              onChange={(v) => setPage({ margins: { ...page.margins, [side]: v } })}
            />
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Groups</legend>
        {report.bands.groups.map((g, i) => (
          <fieldset key={g.id}>
            <legend>{groupLabel(g, i)}</legend>
            {columns.length > 0 && (
              <label>
                Group {i + 1} field
                <select
                  value=""
                  onChange={(e) =>
                    e.target.value && setGroup(g.id, { groupBy: fieldExpression(e.target.value) })
                  }
                >
                  <option value="">Choose a field…</option>
                  {columns.map((col) => (
                    <option key={col} value={col}>
                      {col}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <ExpressionInput
              label={`Group ${i + 1} expression`}
              value={g.groupBy}
              onChange={(groupBy) => setGroup(g.id, { groupBy })}
            />
            <label className="inline">
              <input
                type="checkbox"
                checked={!!g.descending}
                onChange={(e) => setGroup(g.id, { descending: e.target.checked })}
              />
              Group {i + 1} descending
            </label>
            <button
              type="button"
              onClick={() =>
                change(
                  (r) => ({
                    ...r,
                    bands: { ...r.bands, groups: r.bands.groups.filter((x) => x.id !== g.id) },
                  }),
                  "Remove group",
                )
              }
            >
              <Trash2 /> Remove group {i + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          onClick={() =>
            change(
              (r) => ({
                ...r,
                bands: {
                  ...r.bands,
                  groups: [
                    ...r.bands.groups,
                    newGroup(columns[0] ? fieldExpression(columns[0]) : ""),
                  ],
                },
              }),
              "Add group",
            )
          }
        >
          <Plus /> Add group
        </button>
      </fieldset>
    </>
  );
}

/** Height and keep-together for the selected band. */
export function BandProperties({
  label,
  band,
  minHeight,
  onChange,
}: {
  label: string;
  band: Band;
  minHeight: number;
  onChange: (patch: Partial<Band>) => void;
}) {
  return (
    <fieldset>
      <legend>{label} band</legend>
      <PointInput
        label="Band height"
        min={minHeight}
        value={band.height}
        onChange={(height) => onChange({ height })}
      />
      <label className="inline">
        <input
          type="checkbox"
          checked={band.keepTogether}
          onChange={(e) => onChange({ keepTogether: e.target.checked })}
        />
        Keep together
      </label>
    </fieldset>
  );
}
