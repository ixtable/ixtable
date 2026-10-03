import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { humanize } from "../design/generate";
import type { DesignControl, DesignForm } from "../design/schema";
import { useDocumentConfig } from "../lib/config-store";
import type { Filter, Sort, TableSchema } from "../lib/types";
import {
  cachedPage,
  loadPage,
  type PageRequest,
  type RecordPage,
  recordIdFor,
  tableSchema,
} from "./data";
import { cellText } from "./formState";
import { useLookupLabels } from "./lookups";
import { useRuntimeNavigation } from "./navigation";
import { can } from "./rbac";
import { isDesignedForm, resolveForm } from "./registry";

type Props = {
  form: DesignForm;
  onOpen: (recordId: unknown) => void;
  onCreate: () => void;
};

/** List mode: DuckDB-backed paging with sort and a contains-filter, rows open the detail form. */
export function ListView({ form, onOpen, onCreate }: Props) {
  const { config } = useDocumentConfig();
  const { roleId } = useRuntimeNavigation();
  const [sorts, setSorts] = useState<Sort[]>([]);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [searchColumn, setSearchColumn] = useState("");
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [error, setError] = useState("");
  const table = form.source?.kind === "table" ? (form.source.table ?? null) : null;
  const detail = (form.detailFormId && resolveForm(config, form.detailFormId)) || form;
  const limit = Math.max(1, form.pageSize || 25);

  const filters: Filter[] = useMemo(
    () =>
      search.trim() && searchColumn
        ? [
            {
              column: searchColumn,
              operator: "contains",
              value: { type: "text", value: search.trim() },
            },
          ]
        : [],
    [search, searchColumn],
  );
  const request: PageRequest = useMemo(
    () => ({ offset, limit, sorts, filters }),
    [offset, limit, sorts, filters],
  );
  const [page, setPage] = useState<RecordPage | null>(() => cachedPage(form, request));

  useEffect(() => {
    let live = true;
    const hit = cachedPage(form, request);
    if (hit) setPage(hit);
    const timer = setTimeout(
      () => {
        loadPage(config, form, request)
          .then((next) => {
            if (!live) return;
            setPage(next);
            setError("");
          })
          .catch(
            (reason) => live && setError(reason instanceof Error ? reason.message : String(reason)),
          );
      },
      search ? 200 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [config, form, request, search]);

  useEffect(() => {
    if (table)
      tableSchema(table)
        .then(setSchema)
        .catch(() => setSchema(null));
  }, [table]);

  const controlFor = (column: string): DesignControl | undefined =>
    [...form.controls, ...detail.controls].find((c) => c.binding?.column === column);
  const columns = form.listColumns.length
    ? form.listColumns
    : form.controls.flatMap((c) => (c.binding?.column ? [c.binding.column] : [])).length
      ? form.controls.flatMap((c) => (c.binding?.column ? [c.binding.column] : []))
      : (page?.columns ?? []);
  const label = (column: string) => controlFor(column)?.label ?? humanize(column);
  const lookup = useLookupLabels(table, columns, controlFor, page?.rows);
  const cell = (record: Record<string, unknown>, column: string) =>
    lookup(column, record[column]) ?? cellText(record[column], controlFor(column));
  const subject = isDesignedForm(config, detail)
    ? { kind: "form", id: detail.id }
    : { kind: "table", id: table ?? "" };
  const canCreate =
    !!table &&
    detail.modes.includes("create") &&
    can(config, roleId, subject.kind, subject.id, "create");
  const effectiveColumn = searchColumn || columns[0] || "";

  const toggleSort = (column: string) => {
    setOffset(0);
    setSorts((current) => {
      const existing = current.find((s) => s.column === column);
      if (!existing) return [{ column, descending: false }];
      if (!existing.descending) return [{ column, descending: true }];
      return [];
    });
  };
  const open = (index: number) => {
    if (!page) return;
    const record = page.rows[index];
    if (table && schema && page.identities)
      onOpen(recordIdFor(schema, record, page.identities[index]));
    else onOpen(record);
  };
  const total = page?.total ?? 0;

  return (
    <section className="rt-list" aria-label={form.name}>
      <div className="rt-record-head">
        <h2>{form.name}</h2>
        <div className="rt-actions">
          <label className="rt-search">
            <span className="sr-only">Search column</span>
            <select
              aria-label="Search column"
              value={effectiveColumn}
              onChange={(e) => {
                setSearchColumn(e.target.value);
                setOffset(0);
              }}
            >
              {columns.map((column) => (
                <option key={column} value={column}>
                  {label(column)}
                </option>
              ))}
            </select>
          </label>
          <input
            type="search"
            aria-label={`Search ${form.name}`}
            placeholder="Search…"
            value={search}
            onChange={(e) => {
              setSearchColumn(effectiveColumn);
              setSearch(e.target.value);
              setOffset(0);
            }}
          />
          {canCreate && (
            <button type="button" className="primary" onClick={onCreate}>
              New {detail.name.toLowerCase()}
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="rt-error" role="alert">
          {error}
        </p>
      )}
      <table className="rt-table">
        <thead>
          <tr>
            {columns.map((column) => {
              const sort = sorts.find((s) => s.column === column);
              return (
                <th
                  key={column}
                  scope="col"
                  aria-sort={sort ? (sort.descending ? "descending" : "ascending") : "none"}
                >
                  <button type="button" onClick={() => toggleSort(column)}>
                    {label(column)}
                    {sort &&
                      (sort.descending ? (
                        <ArrowDown aria-hidden="true" />
                      ) : (
                        <ArrowUp aria-hidden="true" />
                      ))}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {page?.rows.map((record, index) => (
            <tr
              key={index}
              tabIndex={0}
              className="rt-row"
              aria-label={`Open ${record[columns[0]] == null ? `row ${offset + index + 1}` : (lookup(columns[0], record[columns[0]]) ?? String(record[columns[0]]))}`}
              onClick={() => open(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  open(index);
                }
              }}
            >
              {columns.map((column) => (
                <td key={column}>{cell(record, column)}</td>
              ))}
            </tr>
          ))}
          {page && !page.rows.length && (
            <tr>
              <td colSpan={Math.max(1, columns.length)} className="rt-muted">
                No records.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="rt-pager">
        <span role="status">
          {total
            ? `${offset + 1}–${Math.min(offset + limit, total)} of ${total}`
            : page
              ? "0 records"
              : "Loading…"}
        </span>
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - limit))}
        >
          Previous page
        </button>
        <button
          type="button"
          disabled={offset + limit >= total}
          onClick={() => setOffset(offset + limit)}
        >
          Next page
        </button>
      </div>
    </section>
  );
}
