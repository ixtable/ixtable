import Editor from "@monaco-editor/react";
import {
  Code2,
  Columns3,
  GitBranch,
  Plus,
  Rows3,
  Save,
  Search,
  Table2,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { asTauriError, executeReadQuery, inspectTable, readTablePage } from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import { deleteRecord, insertRecord, updateRecord } from "../lib/records";
import type {
  AlterTableOperation,
  CreateTableSpec,
  DataValue,
  DbPage,
  QueryResult,
  Sort,
  TableSchema,
} from "../lib/types";
import { newId } from "../lib/utils";
import { useShell } from "../shell/context";
import { alterDatabaseTable, createDatabaseTable } from "./api";
import { CreateTableForm } from "./CreateTableForm";
import { showValue } from "./format";
import { RelationshipBrowser } from "./RelationshipBrowser";
import { ResultGrid } from "./ResultGrid";
import { TableSchemaDesigner } from "./TableSchemaDesigner";

const PAGE_SIZE = 100;

export function DatabaseWorkbench() {
  const { objects, selection: active, select: onSelect, reloadMetadata, markDirty } = useShell();
  const { config, update } = useDocumentConfig();
  const queries = config.savedQueries;
  const [schemas, setSchemas] = useState<TableSchema[]>([]),
    [page, setPage] = useState<DbPage | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const selected = active?.kind === "table" || active?.kind === "view" ? active.id : "";
  const readOnly = active?.kind === "view";
  const sqlMode = active?.kind === "query" || active?.kind === "new-query";
  const creating = active?.kind === "new-table";
  const [sorts, setSorts] = useState<Sort[]>([]),
    [filter, setFilter] = useState(""),
    [sql, setSql] = useState("SELECT 1 AS example"),
    [queryName, setQueryName] = useState("Untitled Query"),
    [queryId, setQueryId] = useState<string | null>(null),
    [result, setResult] = useState<QueryResult | null>(null),
    [designingSelected, setDesigningSelected] = useState(false),
    [altering, setAltering] = useState(false);
  const [draft, setDraft] = useState<Record<number, string>>({}),
    [draftError, setDraftError] = useState("");
  const refresh = () => setRevision((x) => x + 1);
  useEffect(() => {
    Promise.all(objects.filter((x) => x.objectType === "table").map((x) => inspectTable(x.name)))
      .then(setSchemas)
      .catch((e) => setError(asTauriError(e).message));
  }, [objects]);
  useEffect(() => {
    if (active?.kind === "query") {
      const query = queries.find((q) => q.id === active.id);
      if (query && query.id !== queryId) {
        setQueryId(query.id);
        setQueryName(query.name);
        setSql(query.sql);
        setResult(null);
        setError("");
      }
    } else if (active?.kind === "new-query") {
      setQueryId(null);
      setQueryName("Untitled Query");
      setSql("SELECT 1 AS example");
      setResult(null);
      setError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.kind, active?.id, queries]);
  useEffect(() => {
    if (!selected || sqlMode) {
      setPage(null);
      return;
    }
    setLoading(true);
    const filters =
      filter && page?.columns[0]
        ? [
            {
              column: page.columns[0].name,
              operator: "contains" as const,
              value: { type: "text" as const, value: filter },
            },
          ]
        : [];
    readTablePage(selected, { offset, limit: PAGE_SIZE, sorts, filters })
      .then(setPage)
      .catch((e) => setError(asTauriError(e).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, offset, sorts, filter, revision, sqlMode]);
  const createTable = async (spec: CreateTableSpec) => {
    await createDatabaseTable(spec);
    markDirty();
    await reloadMetadata();
    onSelect({ kind: "table", id: spec.name });
    setOffset(0);
  };
  const finishAlter = async (operation: AlterTableOperation) => {
    setAltering(true);
    setError("");
    try {
      await alterDatabaseTable(selected, operation);
      const nextName = operation.operation === "rename_table" ? operation.newName : selected;
      markDirty();
      await reloadMetadata();
      onSelect({ kind: "table", id: nextName });
      setDesigningSelected(false);
      refresh();
    } catch (e) {
      setError(asTauriError(e).message);
    } finally {
      setAltering(false);
    }
  };
  const runSql = async () => {
    setLoading(true);
    setError("");
    try {
      setResult(await executeReadQuery(sql));
    } catch (e) {
      setError(asTauriError(e).message);
    } finally {
      setLoading(false);
    }
  };
  const saveQuery = async () => {
    setLoading(true);
    setError("");
    try {
      await executeReadQuery(sql);
      const id = queryId ?? newId();
      await update((draft) => {
        const existing = draft.savedQueries.find((q) => q.id === id);
        const query = { filterState: null, ...existing, id, name: queryName, sql };
        return {
          ...draft,
          savedQueries: existing
            ? draft.savedQueries.map((q) => (q.id === id ? query : q))
            : [...draft.savedQueries, query],
        };
      }, `Save query ${queryName}`);
      setQueryId(id);
      onSelect({ kind: "query", id });
    } catch (e) {
      setError(asTauriError(e).message);
    } finally {
      setLoading(false);
    }
  };
  const deleteQuery = async () => {
    if (!queryId || !window.confirm(`Delete ${queryName}?`)) return;
    setLoading(true);
    setError("");
    try {
      await update(
        (draft) => ({
          ...draft,
          savedQueries: draft.savedQueries.filter((q) => q.id !== queryId),
        }),
        `Delete query ${queryName}`,
      );
      onSelect(null);
    } catch (e) {
      setError(asTauriError(e).message);
    } finally {
      setLoading(false);
    }
  };
  const commit = async (row: number, column: number, text: string) => {
    if (!page) return;
    const meta = page.columns[column];
    let value: DataValue = { type: "text", value: text };
    if (text === "NULL") value = { type: "null" };
    else if (/INT/i.test(meta.declaredType) && /^-?\d+$/.test(text))
      value = { type: "integer", value: Number(text) };
    else if (/REAL|FLOA|DOUB|NUM/i.test(meta.declaredType) && Number.isFinite(Number(text)))
      value = { type: "real", value: Number(text) };
    try {
      await updateRecord(selected, [{ column: meta.name, value }], page.identities[row]);
      markDirty();
      refresh();
    } catch (e) {
      setError(asTauriError(e).message);
    }
  };
  const remove = async (row: number) => {
    if (!page || !window.confirm("Delete this row?")) return;
    try {
      await deleteRecord(selected, page.identities[row]);
      markDirty();
      if (page.rows.length === 1 && offset) setOffset(Math.max(0, offset - PAGE_SIZE));
      else refresh();
    } catch (e) {
      setError(asTauriError(e).message);
    }
  };
  const insert = async () => {
    if (!page) return;
    setDraftError("");
    try {
      const values = Object.entries(draft)
        .filter(([, text]) => text !== "")
        .map(([index, text]) => {
          const column = page.columns[Number(index)];
          let value: DataValue = { type: "text", value: text };
          if (text === "NULL") value = { type: "null" };
          else if (/INT/i.test(column.declaredType)) {
            if (!/^-?\d+$/.test(text)) throw new Error(`${column.name} requires an integer`);
            const integer = Number(text);
            if (!Number.isSafeInteger(integer))
              throw new Error(`${column.name} is outside the safe integer range`);
            value = { type: "integer", value: integer };
          } else if (/REAL|FLOA|DOUB|NUM/i.test(column.declaredType)) {
            if (!Number.isFinite(Number(text))) throw new Error(`${column.name} requires a number`);
            value = { type: "real", value: Number(text) };
          }
          return { column: column.name, value };
        });
      await insertRecord(selected, values);
      setDraft({});
      markDirty();
      refresh();
    } catch (e) {
      setDraftError(asTauriError(e).message);
    }
  };
  const selectedSchema = schemas.find((schema) => schema.name === selected);
  const inspectorVisible = creating || sqlMode || !!selected;
  return (
    <section className={`workbench ${inspectorVisible ? "" : "relationship-only"}`}>
      <div className="pane relationship-pane">
        <div className="pane-title">
          <div>
            <GitBranch />
            <span>Relationship Browser</span>
            <b>
              {schemas.length} tables · {schemas.reduce((n, s) => n + s.foreignKeys.length, 0)}{" "}
              relationships
            </b>
          </div>
          <span className="canvas-help">Drag to arrange · Scroll to zoom</span>
        </div>
        <RelationshipBrowser
          objects={objects}
          schemas={schemas}
          selected={selected}
          onSelect={(name) => {
            onSelect({ kind: "table", id: name });
            setOffset(0);
          }}
        />
      </div>
      {inspectorVisible && (
        <>
          <div className="split-handle">
            <span>•••</span>
          </div>
          <div className="pane data-pane">
            {designingSelected && selectedSchema ? (
              <TableSchemaDesigner
                schema={selectedSchema}
                loading={altering}
                error={error}
                onApply={finishAlter}
                onCancel={() => setDesigningSelected(false)}
              />
            ) : creating ? (
              <CreateTableForm onCreate={createTable} onCancel={() => onSelect(null)} />
            ) : sqlMode ? (
              <div className="sql-workspace">
                <div className="pane-title">
                  <div>
                    <Code2 />
                    <input
                      aria-label="Query name"
                      value={queryName}
                      onChange={(e) => setQueryName(e.target.value)}
                    />
                    <b>Read-only SQL</b>
                    <button className="save" disabled={loading} onClick={runSql}>
                      Run
                    </button>
                    <button disabled={loading} onClick={saveQuery}>
                      <Save />
                      Save query
                    </button>
                    {queryId && (
                      <button aria-label="Delete query" disabled={loading} onClick={deleteQuery}>
                        <Trash2 />
                        Delete
                      </button>
                    )}
                  </div>
                </div>
                <div className="monaco-shell">
                  <Editor
                    height="170px"
                    language="sql"
                    value={sql}
                    onChange={(value) => setSql(value ?? "")}
                    options={{ minimap: { enabled: false }, fontSize: 12, automaticLayout: true }}
                  />
                </div>
                {error && (
                  <div className="error" role="alert">
                    {error}
                  </div>
                )}
                {result && <ResultGrid result={result} />}
              </div>
            ) : !selected ? (
              <div className="empty-recent select-table">
                <Table2 />
                <b>Select a table</b>
                <span>Choose a table or view from the object browser.</span>
              </div>
            ) : (
              <>
                <div className="pane-title">
                  <div>
                    <Table2 />
                    <span>{selected}</span>
                    {readOnly && <b>Read-only view</b>}
                    <b>{page?.total.toLocaleString() ?? "—"} records</b>
                    <label className="grid-search">
                      <Search />
                      <input
                        placeholder="Filter first column"
                        aria-label="Filter first column"
                        value={filter}
                        onChange={(e) => {
                          setFilter(e.target.value);
                          setOffset(0);
                        }}
                      />
                    </label>
                    <button onClick={refresh}>
                      <Search />
                      Refresh
                    </button>
                    {!readOnly && (
                      <button onClick={() => setDesigningSelected(true)}>
                        <Columns3 />
                        Design table
                      </button>
                    )}
                  </div>
                </div>
                {error && (
                  <div className="error" role="alert">
                    {error}
                  </div>
                )}
                {draftError && (
                  <div className="error" role="alert">
                    {draftError}
                  </div>
                )}
                <div className="data-grid">
                  <table>
                    <thead>
                      <tr>
                        <th className="rownum">#</th>
                        {page?.columns.map((c) => (
                          <th key={c.name}>
                            <button
                              onClick={() =>
                                setSorts((old) => [
                                  {
                                    column: c.name,
                                    descending:
                                      old[0]?.column === c.name ? !old[0].descending : false,
                                  },
                                ])
                              }
                            >
                              {c.name}{" "}
                              {sorts[0]?.column === c.name ? (sorts[0].descending ? "↓" : "↑") : ""}
                            </button>
                            <small>{c.declaredType}</small>
                          </th>
                        ))}
                        {!readOnly && <th />}
                      </tr>
                    </thead>
                    <tbody>
                      {page?.rows.map((row, i) => (
                        <tr key={JSON.stringify(page.identities[i])}>
                          <td className="rownum">{offset + i + 1}</td>
                          {row.map((v, j) => (
                            <td
                              key={j}
                              className={page.columns[j].primaryKeyPosition ? "primary" : ""}
                            >
                              {readOnly || page.columns[j].generated ? (
                                <span>{showValue(v)}</span>
                              ) : (
                                <input
                                  defaultValue={showValue(v)}
                                  aria-label={`${page.columns[j].name}, row ${offset + i + 1}`}
                                  onKeyDown={(e) => {
                                    navigateDraft(e, j);
                                    if (e.key === "Enter") {
                                      e.currentTarget.blur();
                                    }
                                  }}
                                  onBlur={(e) => {
                                    if (e.currentTarget.value !== showValue(v))
                                      void commit(i, j, e.currentTarget.value);
                                  }}
                                />
                              )}
                            </td>
                          ))}
                          {!readOnly && (
                            <td>
                              <button
                                aria-label={`Delete row ${offset + i + 1}`}
                                onClick={() => void remove(i)}
                              >
                                <Trash2 />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                      {page && !readOnly && (
                        <tr className="draft-row">
                          <td className="rownum">+</td>
                          {page.columns.map((column, j) => (
                            <td key={column.name}>
                              {column.generated ? (
                                <span>Generated</span>
                              ) : (
                                <input
                                  data-draft-index={j}
                                  aria-label={`New ${column.name}`}
                                  placeholder={column.defaultValue ? "Default" : "Enter value"}
                                  value={draft[j] ?? ""}
                                  onChange={(e) => setDraft((x) => ({ ...x, [j]: e.target.value }))}
                                  onKeyDown={(e) => {
                                    navigateDraft(e, j);
                                    if (e.key === "Enter") void insert();
                                    if (e.key === "Escape") {
                                      setDraft({});
                                      setDraftError("");
                                    }
                                  }}
                                />
                              )}
                            </td>
                          ))}
                          <td>
                            <button aria-label="Insert row" onClick={() => void insert()}>
                              <Plus />
                            </button>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {page && !page.rows.length && (
                    <div className="empty-recent">
                      <Rows3 />
                      <b>No records yet</b>
                      <span>
                        {readOnly
                          ? "This view returned no records."
                          : "Use the new row above to add the first record."}
                      </span>
                    </div>
                  )}
                </div>
                <div className="grid-footer">
                  <span>
                    {page?.total
                      ? `${offset + 1}–${Math.min(offset + (page?.rows.length || 0), page.total)} of ${page.total}`
                      : "0 records"}
                  </span>
                  <div>
                    <button
                      aria-label="Previous page"
                      disabled={!offset}
                      onClick={() => setOffset((x) => Math.max(0, x - PAGE_SIZE))}
                    >
                      ‹
                    </button>
                    <button
                      aria-label="Next page"
                      disabled={!page || offset + PAGE_SIZE >= page.total}
                      onClick={() => setOffset((x) => x + PAGE_SIZE)}
                    >
                      ›
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function navigateDraft(event: React.KeyboardEvent<HTMLInputElement>, index: number) {
  const input = event.currentTarget;
  let next = index;
  if (event.key === "ArrowRight" && input.selectionStart === input.value.length) next = index + 1;
  if (event.key === "ArrowLeft" && input.selectionStart === 0) next = index - 1;
  if (event.key === "ArrowDown") next = index + 1;
  if (event.key === "ArrowUp") next = index - 1;
  if (next === index) return;
  const target = document.querySelector<HTMLInputElement>(`[data-draft-index="${next}"]`);
  if (target) {
    event.preventDefault();
    target.focus();
    target.select();
  }
}
