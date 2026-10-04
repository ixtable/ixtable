import { Database, Eye, Plus, Search, Table2 } from "lucide-react";
import { useContext, useState } from "react";
import type { SavedQuery } from "../query/types";
import type { DbObject } from "../lib/types";
import { type Selection, ShellContext } from "./context";

export function ObjectBrowser({
  objects,
  queries,
  loading,
  error,
  active,
  onSelect,
}: {
  objects: DbObject[];
  queries: SavedQuery[];
  loading: boolean;
  error: string;
  active: Selection | null;
  onSelect: (value: Selection) => void;
}) {
  const [search, setSearch] = useState("");
  const shell = useContext(ShellContext);
  /** Saved queries open in Query mode. */
  const choose = (value: Selection) => {
    onSelect(value);
    if ((value.kind === "query" || value.kind === "new-query") && shell)
      void shell.changeMode("query");
  };
  const needle = search.trim().toLowerCase();
  const tablesAndViews = objects.filter(
    (o) =>
      (o.objectType === "table" || o.objectType === "view") &&
      !o.name.startsWith("_ixtable_") &&
      o.name.toLowerCase().includes(needle),
  );
  const visibleQueries = queries.filter((q) => q.name.toLowerCase().includes(needle));
  const group = (
    label: string,
    items: Array<DbObject | SavedQuery>,
    fallbackKind: "table" | "query",
  ) => (
    <section
      className="object-group"
      aria-labelledby={`object-group-${label.toLowerCase().replaceAll(" ", "-")}`}
    >
      <div className="object-group-heading">
        <Database />
        <h3 id={`object-group-${label.toLowerCase().replaceAll(" ", "-")}`}>{label}</h3>
        <em>{items.length}</em>
        {label === "Tables" && (
          <button
            aria-label="New table"
            aria-pressed={active?.kind === "new-table"}
            onClick={() => onSelect({ kind: "new-table", id: "" })}
          >
            <Plus />
          </button>
        )}
        {label === "Queries" && (
          <button aria-label="New query" onClick={() => choose({ kind: "new-query", id: "" })}>
            <Plus />
          </button>
        )}
      </div>
      <ul>
        {items.map((item) => {
          const id = "id" in item ? item.id : item.name;
          const name = item.name;
          const kind: "table" | "view" | "query" =
            "objectType" in item ? (item.objectType === "view" ? "view" : "table") : fallbackKind;
          const Icon = kind === "view" ? Eye : Table2;
          return (
            <li key={id}>
              <button
                className={active?.kind === kind && active.id === id ? "selected" : ""}
                aria-pressed={active?.kind === kind && active.id === id}
                onClick={() => choose({ kind, id })}
              >
                <Icon />
                <span>
                  {name}
                  {kind === "view" && <small>Read-only</small>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!items.length && needle && <small className="object-empty">No matches</small>}
      {label === "Scripts" && (
        <small className="object-empty">Workflow scripts are not available yet</small>
      )}
    </section>
  );
  return (
    <section className="object-browser" aria-label="Database objects">
      <div className="object-browser-title">
        <span>OBJECTS</span>
        {loading && <span role="status">Loading…</span>}
      </div>
      <label className="object-search">
        <Search />
        <input
          aria-label="Search database objects"
          placeholder="Search objects"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {error && <small role="alert">{error}</small>}
      <div className="object-groups">
        {group("Tables", tablesAndViews, "table")}
        {group("Queries", visibleQueries, "query")}
        {group("Scripts", [], "query")}
      </div>
    </section>
  );
}
