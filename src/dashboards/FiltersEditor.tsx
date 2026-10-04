/** Dashboard filters: name, query parameter, control, choices and default value. */
import { LayoutGrid, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { useDocumentConfig } from "../lib/config-store";
import { QueryPicker } from "../query/QueryPicker";
import { PARAMETER_TYPES } from "../query/types";
import { dashboardQueryParameters, newFilter } from "./model";
import { FILTER_CONTROLS, type Dashboard, type DashboardFilter, type FilterControl } from "./types";

const CONTROL_LABELS: Record<FilterControl, string> = {
  select: "Drop-down list",
  text: "Text box",
  date: "Date",
  number: "Number",
  dateRange: "Date range",
};

const title = (param: string) => (param ? param[0].toUpperCase() + param.slice(1) : "Filter");

export function FiltersEditor({
  dashboard,
  onChange,
  onPlace,
}: {
  dashboard: Dashboard;
  onChange: (filters: DashboardFilter[], label: string) => void;
  onPlace: (filter: DashboardFilter) => void;
}) {
  const { config } = useDocumentConfig();
  const listId = useId();
  const declared = dashboardQueryParameters(dashboard, config.savedQueries);
  const used = new Set(dashboard.filters.map((f) => f.param));
  const add = () => {
    const next = declared.find((p) => !used.has(p.name));
    const filter = newFilter(title(next?.name ?? ""), next?.name ?? "");
    if (next) {
      filter.logicalType = next.logicalType;
      filter.control =
        next.logicalType === "date"
          ? "date"
          : ["integer", "number"].includes(next.logicalType)
            ? "number"
            : "select";
    }
    onChange([...dashboard.filters, filter], "Add filter");
  };
  const edit = (id: string, patch: Partial<DashboardFilter>, label = "Edit filter") =>
    onChange(
      dashboard.filters.map((f) => (f.id === id ? { ...f, ...patch } : f)),
      label,
    );
  return (
    <fieldset className="fd-fieldset dash-filters-editor">
      <legend>Filters</legend>
      <datalist id={listId}>
        {declared.map((p) => (
          <option key={p.name} value={p.name} />
        ))}
      </datalist>
      {!dashboard.filters.length && (
        <p className="fd-hint">
          Filters pass their value to every query parameter with the same name.
        </p>
      )}
      {dashboard.filters.map((filter) => {
        const name = filter.name || filter.param || "Filter";
        return (
          <fieldset key={filter.id} className="fd-fieldset" aria-label={`Filter ${name}`}>
            <legend>{name}</legend>
            <label>
              Filter name
              <input
                value={filter.name}
                onChange={(e) => edit(filter.id, { name: e.target.value })}
              />
            </label>
            <label>
              Parameter
              <input
                list={listId}
                className="fd-code"
                value={filter.param}
                onChange={(e) => edit(filter.id, { param: e.target.value.trim() })}
              />
            </label>
            <label>
              Control
              <select
                value={filter.control}
                onChange={(e) => edit(filter.id, { control: e.target.value as FilterControl })}
              >
                {FILTER_CONTROLS.map((c) => (
                  <option key={c} value={c}>
                    {CONTROL_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Value type
              <select
                value={filter.logicalType}
                onChange={(e) => edit(filter.id, { logicalType: e.target.value })}
              >
                {PARAMETER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {filter.control === "select" && (
              <>
                <ChoicesInput
                  key={filter.id}
                  options={filter.options ?? []}
                  onChange={(options) => edit(filter.id, { options })}
                />
                <QueryPicker
                  label="Choices from query"
                  value={filter.optionsQueryId}
                  onChange={(id) => edit(filter.id, { optionsQueryId: id || null })}
                />
              </>
            )}
            {filter.control !== "dateRange" && (
              <label>
                Default value
                <input
                  value={
                    filter.default === undefined || filter.default === null
                      ? ""
                      : String(filter.default)
                  }
                  onChange={(e) =>
                    edit(filter.id, { default: e.target.value === "" ? undefined : e.target.value })
                  }
                />
              </label>
            )}
            <div className="fd-row">
              <button type="button" onClick={() => onPlace(filter)}>
                <LayoutGrid aria-hidden="true" /> Place {name} on canvas
              </button>
              <button
                type="button"
                aria-label={`Remove filter ${name}`}
                onClick={() =>
                  onChange(
                    dashboard.filters.filter((f) => f.id !== filter.id),
                    "Remove filter",
                  )
                }
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          </fieldset>
        );
      })}
      <button type="button" onClick={add}>
        <Plus aria-hidden="true" /> Add filter
      </button>
    </fieldset>
  );
}

/** Comma-separated choices; keeps the typed text so separators are not swallowed. */
function ChoicesInput({
  options,
  onChange,
}: {
  options: string[];
  onChange: (options: string[]) => void;
}) {
  const [draft, setDraft] = useState(options.join(", "));
  return (
    <label>
      Choices
      <input
        placeholder="East, West"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange(
            e.target.value
              .split(",")
              .map((o) => o.trim())
              .filter(Boolean),
          );
        }}
      />
    </label>
  );
}
