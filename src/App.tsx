import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Editor from "@monaco-editor/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Archive,
  ChevronDown,
  Code2,
  Columns3,
  Database,
  Eye,
  FilePlus2,
  FolderOpen,
  GitBranch,
  Grid3X3,
  ListFilter,
  Plus,
  Rows3,
  Save,
  Search,
  Shapes,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { chooseDocumentDestination, chooseDocumentToOpen } from "./lib/dialog";

type Mode = "data" | "design";
export interface SessionState {
  sessionId: string;
  documentId: string;
  name: string;
  path?: string | null;
  workspace: string;
  dirty: boolean;
  conflict: boolean;
  saving: boolean;
  activeMode: string;
  attachmentCount: number;
  autosaveEligible: boolean;
}
type SavedQuery = { id: string; name: string; sql: string; filterState?: unknown };
export interface DocumentConfig {
  version: number;
  name: string;
  activeMode: string;
  navigationState: unknown;
  settings: unknown;
  savedQueries: SavedQuery[];
}
export interface TauriError {
  code: string;
  message: string;
}
type Doc = {
  name: string;
  path?: string;
  dirty: boolean;
  mode: Mode;
  sessionId: string;
  documentId: string;
};
type RecentFile = { path: string; openedAt: string };
type RecoverySession = {
  sessionId: string;
  documentId: string;
  workspace: string;
  documentPath?: string | null;
  updatedAt: string;
};
type DataValue = {
  type: "null" | "integer" | "real" | "text" | "blob" | "boolean" | "date" | "timestamp";
  value?: string | number | boolean;
};
type DbObject = { name: string; objectType: string; rowCount: number | null };
type DbColumn = {
  name: string;
  declaredType: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKeyPosition: number;
  generated: boolean;
};
type DbForeignKey = {
  id: number;
  fromColumns: string[];
  targetTable: string;
  targetColumns: string[];
  onUpdate: string;
  onDelete: string;
};
type DbSchema = {
  name: string;
  columns: DbColumn[];
  foreignKeys: DbForeignKey[];
  withoutRowid: boolean;
};
type DbPage = {
  columns: DbColumn[];
  rows: DataValue[][];
  identities: DataValue[][];
  total: number;
  offset: number;
  limit: number;
};
type CreateColumnSpec = {
  name: string;
  declaredType: string;
  nullable: boolean;
  primaryKeyPosition: number;
  unique: boolean;
  defaultExpression: string | null;
  generatedExpression: string | null;
};
type AlterTableOperation =
  | { operation: "rename_table"; newName: string }
  | { operation: "rename_column"; column: string; newName: string }
  | { operation: "add_column"; column: CreateColumnSpec }
  | { operation: "drop_column"; column: string };
const asTauriError = (error: unknown): TauriError => {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const structured = error as TauriError;
    const nested = structured.message.match(/^([A-Z][A-Z_]+):\s*(.*)/);
    return nested ? { code: nested[1], message: nested[2] } : structured;
  }
  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error) as TauriError;
      if (parsed.code && parsed.message) return parsed;
    } catch {
      /* use bridge message */
    }
    const match = error.match(/([A-Z][A-Z_]+):\s*(.*)/);
    if (match) return { code: match[1], message: match[2] };
  }
  return { code: "TAURI_ERROR", message: error instanceof Error ? error.message : String(error) };
};
const fromSession = (state: SessionState): Doc => ({
  name: state.name,
  path: state.path ?? undefined,
  dirty: state.dirty,
  mode: state.activeMode === "design" ? "design" : "data",
  sessionId: state.sessionId,
  documentId: state.documentId,
});
export default function App() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [notice, setNotice] = useState("");
  const [view, setView] = useState("Data view");
  const [designPreview, setDesignPreview] = useState(false);
  const [pending, setPending] = useState("");
  const [error, setError] = useState<TauriError | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [recoveries, setRecoveries] = useState<RecoverySession[]>([]);
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [objects, setObjects] = useState<DbObject[]>([]),
    [savedQueries, setSavedQueries] = useState<SavedQuery[]>([]),
    [metadataLoading, setMetadataLoading] = useState(false),
    [metadataError, setMetadataError] = useState("");
  const [activeObject, setActiveObject] = useState<{
    kind: "table" | "view" | "query" | "new-query";
    id: string;
  } | null>(null);
  const refreshStartLists = async () => {
    try {
      const [recent, recovery] = await Promise.all([
        invoke<RecentFile[]>("list_recent_files"),
        invoke<RecoverySession[]>("list_recovery_sessions"),
      ]);
      setRecentFiles(recent);
      setRecoveries(recovery);
    } catch (reason) {
      setError(asTauriError(reason));
    }
  };
  useEffect(() => {
    void refreshStartLists();
  }, []);
  const loadMetadata = async () => {
    if (!doc) return;
    setMetadataLoading(true);
    setMetadataError("");
    try {
      const [next, config] = await Promise.all([
        invoke<DbObject[]>("list_database_objects", { windowLabel: "main" }),
        invoke<DocumentConfig>("read_document_config", { windowLabel: "main" }),
      ]);
      setObjects(next);
      setSavedQueries(config.savedQueries ?? []);
    } catch (reason) {
      setMetadataError(asTauriError(reason).message);
    } finally {
      setMetadataLoading(false);
    }
  };
  useEffect(() => {
    if (doc && doc.mode === "data") void loadMetadata();
    else if (!doc) {
      setObjects([]);
      setSavedQueries([]);
      setActiveObject(null);
    }
  }, [doc?.sessionId, doc?.mode]);
  useEffect(() => {
    const reload = () => void loadMetadata();
    window.addEventListener("ixtable:database-changed", reload);
    return () => window.removeEventListener("ixtable:database-changed", reload);
  }, [doc?.sessionId]);
  useEffect(() => {
    document.title = doc ? `${doc.name}${doc.dirty ? " •" : ""} — ixtable` : "ixtable";
  }, [doc]);
  const create = async () => {
    setPending("Creating document…");
    setError(null);
    try {
      const state = await invoke<SessionState>("new_document", { windowLabel: "main" });
      setDoc(fromSession(state));
      await refreshStartLists();
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setPending("");
    }
  };
  const open = async () => {
    setPending("Choosing document…");
    setError(null);
    setNotice("");
    try {
      const path = await chooseDocumentToOpen();
      if (!path) {
        setNotice("Open canceled.");
        return;
      }
      const state = await invoke<SessionState>("open_document", {
        windowLabel: "main",
        path,
      });
      setDoc(fromSession(state));
      await refreshStartLists();
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setPending("");
    }
  };
  const openPath = async (path: string) => {
    setPending("Opening document…");
    setError(null);
    try {
      setDoc(
        fromSession(await invoke<SessionState>("open_document", { windowLabel: "main", path })),
      );
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setPending("");
      await refreshStartLists();
    }
  };
  const recover = async (sessionId: string) => {
    setPending("Recovering document…");
    setError(null);
    try {
      setDoc(
        fromSession(
          await invoke<SessionState>("reopen_recovery_session", { windowLabel: "main", sessionId }),
        ),
      );
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setPending("");
      await refreshStartLists();
    }
  };
  const discardRecovery = async (sessionId: string) => {
    setPending("Discarding recovery…");
    setError(null);
    try {
      await invoke("discard_recovery", { sessionId });
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setPending("");
      await refreshStartLists();
    }
  };
  const update = (patch: Partial<Doc>) =>
    setDoc((d) => (d ? { ...d, ...patch, dirty: patch.dirty ?? true } : d));
  const changeMode = async (mode: Mode) => {
    if (!doc || doc.mode === mode) return;
    setPending(`Switching to ${mode} mode…`);
    setError(null);
    try {
      const config = await invoke<DocumentConfig>("read_document_config", { windowLabel: "main" });
      const state = await invoke<SessionState>("update_document_config", {
        windowLabel: "main",
        config: { ...config, activeMode: mode },
      });
      setDoc(fromSession(state));
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setPending("");
    }
  };
  const save = async (forceDestination = false) => {
    if (!doc) return;
    setPending("Saving document…");
    setError(null);
    setNotice("");
    try {
      if (forceDestination || !doc.path) {
        const path = await chooseDocumentDestination(doc.name);
        if (!path) {
          setNotice("Save canceled.");
          return;
        }
        setDoc(
          fromSession(
            await invoke<SessionState>("save_document_as", { windowLabel: "main", path }),
          ),
        );
      } else {
        setDoc(fromSession(await invoke<SessionState>("save_document", { windowLabel: "main" })));
      }
      await refreshStartLists();
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setPending("");
    }
  };
  const close = async () => {
    if (!doc) return;
    const discard = doc.dirty
      ? window.confirm("Discard unsaved changes and close this document?")
      : false;
    if (doc.dirty && !discard) return;
    setPending("Closing document…");
    setError(null);
    try {
      await invoke("close_document", { windowLabel: "main", force: discard });
      setDoc(null);
      setDesignPreview(false);
      await refreshStartLists();
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setPending("");
    }
  };
  const runAction = (label: string) =>
    setNotice(`${label} is available from the active data view.`);
  if (!doc)
    return (
      <div className="start-screen">
        <div className="start-brand">
          <span>ix</span>
          <b>ixtable</b>
        </div>
        <main className="start-main">
          <p className="kicker">DOCUMENT DATABASE</p>
          <h1>Your data, in one portable file.</h1>
          <p className="intro">
            Create or open an ixtable document. Every database, setting, and attachment stays
            together inside its .ixt archive.
          </p>
          <div className="start-actions">
            <button className="hero-action" disabled={!!pending} onClick={create}>
              <FilePlus2 />
              <span>
                <b>New document</b>
                <small>Start with an empty database</small>
              </span>
            </button>
            <button disabled={!!pending} onClick={open}>
              <FolderOpen />
              <span>
                <b>Open document</b>
                <small>Choose an .ixt file</small>
              </span>
            </button>
          </div>
          {pending && (
            <div className="progress" role="status">
              {pending}
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              <b>{error.code}</b>
              <span>{error.message}</span>
              <button aria-label="Dismiss error" onClick={() => setError(null)}>
                <X />
              </button>
            </div>
          )}
          <section className="start-section">
            <div>
              <h2>Recent documents</h2>
              {recentFiles.length > 5 && (
                <button className="text-button" onClick={() => setShowAllRecent((value) => !value)}>
                  {showAllRecent ? "Show less" : "View all"}
                </button>
              )}
            </div>
            {recentFiles.length === 0 ? (
              <div className="empty-recent">
                <Database />
                <b>No recent documents</b>
                <span>Documents you open will appear here.</span>
              </div>
            ) : (
              <div className="start-list">
                {recentFiles.slice(0, showAllRecent ? undefined : 5).map((recent) => (
                  <button
                    key={recent.path}
                    disabled={!!pending}
                    onClick={() => void openPath(recent.path)}
                  >
                    <FolderOpen />
                    <span>
                      <b>{recent.path.split(/[\\/]/).pop()}</b>
                      <small>{recent.path}</small>
                    </span>
                    <time>{new Date(recent.openedAt).toLocaleString()}</time>
                  </button>
                ))}
              </div>
            )}
          </section>
          {recoveries.length > 0 && (
            <section className="start-section recovery-section">
              <div>
                <h2>Recover unsaved work</h2>
              </div>
              <div className="start-list">
                {recoveries.map((recovery) => (
                  <article key={recovery.sessionId}>
                    <Archive />
                    <span>
                      <b>{recovery.documentPath?.split(/[\\/]/).pop() ?? "Untitled document"}</b>
                      <small>
                        {recovery.documentPath ?? `Document ${recovery.documentId.slice(0, 8)}`}
                      </small>
                      <time>Last updated {new Date(recovery.updatedAt).toLocaleString()}</time>
                    </span>
                    <div>
                      <button disabled={!!pending} onClick={() => void recover(recovery.sessionId)}>
                        Recover
                      </button>
                      <button
                        disabled={!!pending}
                        onClick={() => void discardRecovery(recovery.sessionId)}
                      >
                        Discard
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </main>
        <footer>
          ixtable <span>Local-first document database</span>
        </footer>
      </div>
    );
  return (
    <div className="document-app">
      <aside className="doc-sidebar">
        <div className="doc-brand">
          <span>ix</span>
          <div className="project-actions">
            <button aria-label="Save project" disabled={!!pending} onClick={() => save()}>
              <Save />
            </button>
            <button aria-label="Save project as" disabled={!!pending} onClick={() => save(true)}>
              <Save />
            </button>
            <button aria-label="Close project" disabled={!!pending} onClick={close}>
              <X />
            </button>
          </div>
        </div>
        <div className="document-label">
          <small>PROJECT</small>
          <strong>{doc.name}</strong>
          <span>{doc.path ? "Saved archive" : "Not saved yet"}</span>
        </div>
        <div className="mode-switch" aria-label="Document mode">
          <button
            className={doc.mode === "data" ? "active" : ""}
            disabled={!!pending}
            onClick={() => changeMode("data")}
          >
            Data
          </button>
          <button
            className={doc.mode === "design" ? "active" : ""}
            disabled={!!pending}
            onClick={() => changeMode("design")}
          >
            Design
          </button>
        </div>
        {doc.mode === "data" ? (
          <ObjectBrowser
            objects={objects}
            queries={savedQueries}
            loading={metadataLoading}
            error={metadataError}
            active={activeObject}
            onSelect={setActiveObject}
          />
        ) : (
          <nav>
            <button className="active">
              <Shapes />
              Forms<span>›</span>
            </button>
            <button>
              <Shapes />
              Switchboards<span>›</span>
            </button>
          </nav>
        )}
        <div className="sidebar-bottom">
          <span className="status-dot" /> {doc.dirty ? "Unsaved changes" : "All changes saved"}
        </div>
      </aside>
      <main className={`workspace ${doc.mode === "data" ? "data-workspace" : ""}`}>
        {doc.mode === "design" && (
          <header className="titlebar">
            <div>
              <p>PROJECT / DESIGN</p>
              <h1>{designPreview ? "Inventory app" : "Form builder"}</h1>
            </div>
            <div className="header-actions">
              <button onClick={() => setDesignPreview((value) => !value)}>
                {designPreview ? "Back to editor" : "Preview app"}
              </button>
              <button className="save" onClick={() => save()}>
                <Save />
                Save
              </button>
            </div>
          </header>
        )}
        <div className="ribbon-tabs">
          <button className="active">Home</button>
          <button>Create</button>
          <button>External Data</button>
          <button>Database Tools</button>
        </div>
        <section className="ribbon" aria-label="Data tools">
          <div className="ribbon-group view-group">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="ribbon-big">
                  <Grid3X3 />
                  <span>{view}</span>
                  <ChevronDown />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="view-menu" sideOffset={6}>
                  <DropdownMenu.Label>Switch view</DropdownMenu.Label>
                  {["Data view", "Design view", "SQL view"].map((v) => (
                    <DropdownMenu.Item
                      key={v}
                      onSelect={() => setView(v)}
                      className={view === v ? "checked" : ""}
                    >
                      {v}
                      <span>{view === v ? "✓" : ""}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <small>View</small>
          </div>
          <RibbonGroup
            label="Manage table"
            items={[
              [ListFilter, "Select"],
              [Archive, "Make Table"],
              [Upload, "Append"],
              [Columns3, "Update"],
              [Trash2, "Delete"],
            ]}
            action={runAction}
          />
          <RibbonGroup
            label="Query Setup"
            items={[
              [GitBranch, "Show Table"],
              [Rows3, "Insert Rows"],
            ]}
            action={runAction}
          />
        </section>
        {pending && (
          <div className="progress" role="status">
            {pending}
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            <b>{error.code}</b>
            <span>{error.message}</span>
            <button aria-label="Dismiss error" onClick={() => setError(null)}>
              <X />
            </button>
          </div>
        )}
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button aria-label="Dismiss" onClick={() => setNotice("")}>
              <X />
            </button>
          </div>
        )}
        {doc.mode === "data" ? (
          <DatabaseWorkbench
            objects={objects}
            active={activeObject}
            onSelect={setActiveObject}
            onMetadata={async (preserve) => {
              await loadMetadata();
              if (!preserve) setActiveObject(null);
            }}
            queries={savedQueries}
            onDirty={() => update({ dirty: true })}
          />
        ) : (
          <DesignStudio preview={designPreview} />
        )}
      </main>
    </div>
  );
}

const showValue = (v: DataValue) =>
  v.type === "null"
    ? "NULL"
    : v.type === "blob"
      ? `Blob (${String(v.value || "").length} base64 chars)`
      : String(v.value ?? "");
function ObjectBrowser({
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
  active: { kind: "table" | "view" | "query" | "new-query"; id: string } | null;
  onSelect: (value: { kind: "table" | "view" | "query" | "new-query"; id: string }) => void;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const tablesAndViews = objects.filter(
    (o) =>
      (o.objectType === "table" || o.objectType === "view") &&
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
        {label === "Queries" && (
          <button aria-label="New query" onClick={() => onSelect({ kind: "new-query", id: "" })}>
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
                onClick={() => onSelect({ kind, id })}
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
function TableSchemaDesigner({
  schema,
  loading,
  error,
  onApply,
  onCancel,
}: {
  schema: DbSchema;
  loading: boolean;
  error: string;
  onApply: (operation: AlterTableOperation) => Promise<void>;
  onCancel: () => void;
}) {
  const [tableName, setTableName] = useState(schema.name);
  const [renameColumn, setRenameColumn] = useState(schema.columns[0]?.name ?? "");
  const [columnName, setColumnName] = useState("");
  const [newColumn, setNewColumn] = useState<CreateColumnSpec>({
    name: "",
    declaredType: "TEXT",
    nullable: true,
    primaryKeyPosition: 0,
    unique: false,
    defaultExpression: null,
    generatedExpression: null,
  });
  const applyDrop = (column: DbColumn) => {
    const related = schema.foreignKeys.filter((key) => key.fromColumns.includes(column.name));
    const detail = related.length
      ? ` It also removes ${related.length} relationship${related.length === 1 ? "" : "s"}.`
      : "";
    if (
      window.confirm(
        `Drop column “${column.name}”? This destructive SQLite change can permanently delete its data.${detail}`,
      )
    )
      void onApply({ operation: "drop_column", column: column.name });
  };
  return (
    <div className="table-designer overflow-auto p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2>Design {schema.name}</h2>
          <p className="mt-1 text-slate-600">
            Edit columns, constraints, and relationships using typed SQLite operations.
          </p>
        </div>
        <button onClick={onCancel}>Close</button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <section className="mt-5 border-t border-slate-200 pt-3">
        <h3>Table</h3>
        <div className="flex flex-wrap items-center gap-3">
          <label className="grid gap-1">
            Table name
            <input value={tableName} onChange={(e) => setTableName(e.target.value)} />
          </label>
          <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-bold whitespace-nowrap text-green-800">
            Direct SQLite change
          </span>
          <button
            disabled={loading || !tableName.trim() || tableName === schema.name}
            onClick={() => void onApply({ operation: "rename_table", newName: tableName })}
          >
            Rename table
          </button>
        </div>
      </section>
      <section className="mt-5 border-t border-slate-200 pt-3">
        <h3>Columns and constraints</h3>
        {schema.columns.map((column) => (
          <div className="flex items-center gap-3 border-b border-slate-100 py-2" key={column.name}>
            <div className="grid min-w-44">
              <b>{column.name}</b>
              <small className="text-slate-600">
                {column.declaredType || "untyped"}
                {column.primaryKeyPosition ? ` · primary key ${column.primaryKeyPosition}` : ""}
                {!column.nullable ? " · required" : ""}
                {column.generated ? " · generated" : ""}
              </small>
            </div>
            <input
              aria-label={`New name for ${column.name}`}
              defaultValue={column.name}
              onChange={(e) => {
                setRenameColumn(column.name);
                setColumnName(e.target.value);
              }}
            />
            <button
              disabled={
                loading || renameColumn !== column.name || !columnName || columnName === column.name
              }
              onClick={() =>
                void onApply({
                  operation: "rename_column",
                  column: column.name,
                  newName: columnName,
                })
              }
            >
              Rename
            </button>
            <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-bold whitespace-nowrap text-green-800">
              Direct · destructive
            </span>
            <button
              className="text-red-700"
              aria-label={`Drop ${column.name}`}
              disabled={loading}
              onClick={() => applyDrop(column)}
            >
              Drop
            </button>
          </div>
        ))}
        <div className="mt-4 flex flex-wrap items-center gap-3 bg-slate-50 p-3">
          <input
            aria-label="New column name"
            placeholder="Column name"
            value={newColumn.name}
            onChange={(e) => setNewColumn((old) => ({ ...old, name: e.target.value }))}
          />
          <select
            aria-label="New column type"
            value={newColumn.declaredType}
            onChange={(e) => setNewColumn((old) => ({ ...old, declaredType: e.target.value }))}
          >
            <option>INTEGER</option>
            <option>REAL</option>
            <option>TEXT</option>
            <option>BLOB</option>
            <option>NUMERIC</option>
          </select>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={newColumn.nullable}
              onChange={(e) => setNewColumn((old) => ({ ...old, nullable: e.target.checked }))}
            />
            Nullable
          </label>
          <input
            aria-label="Default expression"
            placeholder="Default expression"
            value={newColumn.defaultExpression ?? ""}
            onChange={(e) =>
              setNewColumn((old) => ({ ...old, defaultExpression: e.target.value || null }))
            }
          />
          <span className="rounded-full bg-green-100 px-2 py-1 text-xs font-bold whitespace-nowrap text-green-800">
            Direct SQLite change
          </span>
          <button
            disabled={loading || !newColumn.name.trim()}
            onClick={() => void onApply({ operation: "add_column", column: newColumn })}
          >
            <Plus />
            Add column
          </button>
        </div>
        <p className="mt-3 border-l-3 border-amber-500 bg-amber-50 p-3 text-slate-600">
          <b>Safe rebuild required:</b> changing existing primary-key, unique, nullability, default,
          generated, or check constraints requires recreating the table while preserving compatible
          data.
        </p>
      </section>
      <section className="mt-5 border-t border-slate-200 pt-3">
        <h3>Relationships</h3>
        {schema.foreignKeys.length ? (
          schema.foreignKeys.map((key) => (
            <div className="flex flex-wrap items-center gap-3 py-2" key={key.id}>
              <b>{key.fromColumns.join(", ")}</b>
              <span>
                → {key.targetTable} ({key.targetColumns.join(", ")})
              </span>
              <small>
                Update {key.onUpdate} · Delete {key.onDelete}
              </small>
              <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-bold whitespace-nowrap text-amber-800">
                Safe rebuild required to change
              </span>
            </div>
          ))
        ) : (
          <p>No foreign-key relationships.</p>
        )}
        <p className="mt-3 border-l-3 border-amber-500 bg-amber-50 p-3 text-slate-600">
          Relationship additions, removals, and action changes are previewed as safe table-rebuild
          migrations and are not directly supported by SQLite ALTER TABLE.
        </p>
      </section>
    </div>
  );
}
function DatabaseWorkbench({
  objects,
  queries,
  active,
  onSelect,
  onMetadata,
  onDirty,
}: {
  objects: DbObject[];
  queries: SavedQuery[];
  active: { kind: "table" | "view" | "query" | "new-query"; id: string } | null;
  onSelect: (value: { kind: "table" | "view" | "query" | "new-query"; id: string } | null) => void;
  onMetadata: (preserve: boolean) => Promise<void>;
  onDirty: () => void;
}) {
  const [schemas, setSchemas] = useState<DbSchema[]>([]),
    [page, setPage] = useState<DbPage | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const selected = active?.kind === "table" || active?.kind === "view" ? active.id : "";
  const readOnly = active?.kind === "view";
  const sqlMode = active?.kind === "query" || active?.kind === "new-query";
  const [sorts, setSorts] = useState<Array<{ column: string; descending: boolean }>>([]),
    [filter, setFilter] = useState(""),
    [sql, setSql] = useState("SELECT 1 AS example"),
    [queryName, setQueryName] = useState("Untitled Query"),
    [queryId, setQueryId] = useState<string | null>(null),
    [result, setResult] = useState<{ columns: string[]; rows: DataValue[][] } | null>(null),
    [designer, setDesigner] = useState(false),
    [designingSelected, setDesigningSelected] = useState(false);
  const [draft, setDraft] = useState<Record<number, string>>({}),
    [draftError, setDraftError] = useState("");
  const [tableName, setTableName] = useState(""),
    [columns, setColumns] = useState([
      { name: "id", type: "INTEGER", pk: true, nullable: false },
      { name: "name", type: "TEXT", pk: false, nullable: true },
    ]);
  const refresh = () => setRevision((x) => x + 1);
  useEffect(() => {
    Promise.all(
      objects
        .filter((x) => x.objectType === "table")
        .map((x) => invoke<DbSchema>("inspect_table", { windowLabel: "main", table: x.name })),
    )
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
              operator: "contains",
              value: { type: "text", value: filter },
            },
          ]
        : [];
    invoke<DbPage>("read_table_page", {
      windowLabel: "main",
      table: selected,
      offset,
      limit: 100,
      sorts,
      filters,
    })
      .then(setPage)
      .catch((e) => setError(asTauriError(e).message))
      .finally(() => setLoading(false));
  }, [selected, offset, sorts, filter, revision, sqlMode]);
  const createTable = async () => {
    if (!tableName.trim() || columns.some((c) => !c.name.trim())) {
      setError("Table and column names are required.");
      return;
    }
    try {
      await invoke("create_database_table", {
        windowLabel: "main",
        spec: {
          name: tableName,
          columns: columns.map((c, i) => ({
            name: c.name,
            declaredType: c.type,
            nullable: c.nullable,
            primaryKeyPosition: c.pk ? i + 1 : 0,
            unique: false,
            defaultExpression: null,
            generatedExpression: null,
          })),
          foreignKeys: [],
          checks: [],
          withoutRowid: false,
        },
      });
      onDirty();
      setDesigner(false);
      setTableName("");
      await onMetadata(false);
    } catch (e) {
      setError(asTauriError(e).message);
    }
  };
  const finishAlter = async (operation: AlterTableOperation) => {
    setLoading(true);
    setError("");
    try {
      await invoke("alter_database_table", {
        windowLabel: "main",
        table: selected,
        operation,
      });
      const nextName = operation.operation === "rename_table" ? operation.newName : selected;
      onDirty();
      await onMetadata(true);
      onSelect({ kind: "table", id: nextName });
      setDesigningSelected(false);
      refresh();
    } catch (e) {
      setError(asTauriError(e).message);
    } finally {
      setLoading(false);
    }
  };
  const runSql = async () => {
    setLoading(true);
    setError("");
    try {
      setResult(await invoke("execute_read_query", { windowLabel: "main", sql }));
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
      const config = await invoke<DocumentConfig>("save_query", {
        windowLabel: "main",
        id: queryId,
        name: queryName,
        sql,
        filterState: null,
      });
      const saved = queryId
        ? config.savedQueries.find((q) => q.id === queryId)
        : config.savedQueries.at(-1);
      if (saved) {
        setQueryId(saved.id);
        onSelect({ kind: "query", id: saved.id });
      }
      onDirty();
      await onMetadata(true);
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
      await invoke("delete_saved_query", { windowLabel: "main", id: queryId });
      onDirty();
      onSelect(null);
      await onMetadata(false);
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
      await invoke("update_row", {
        windowLabel: "main",
        table: selected,
        values: [{ column: meta.name, value }],
        identity: page.identities[row],
      });
      onDirty();
      refresh();
    } catch (e) {
      setError(asTauriError(e).message);
    }
  };
  const remove = async (row: number) => {
    if (!page || !window.confirm("Delete this row?")) return;
    try {
      await invoke("delete_row", {
        windowLabel: "main",
        table: selected,
        identity: page.identities[row],
      });
      onDirty();
      if (page.rows.length === 1 && offset) setOffset(Math.max(0, offset - 100));
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
      await invoke("insert_row", { windowLabel: "main", table: selected, values });
      setDraft({});
      onDirty();
      refresh();
    } catch (e) {
      setDraftError(asTauriError(e).message);
    }
  };
  const selectedSchema = schemas.find((schema) => schema.name === selected);
  const inspectorVisible = designer || sqlMode || !!selected;
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
                loading={loading}
                error={error}
                onApply={finishAlter}
                onCancel={() => setDesigningSelected(false)}
              />
            ) : designer ? (
              <div className="table-designer">
                <h2>Create table</h2>
                <label>
                  Table name
                  <input
                    value={tableName}
                    onChange={(e) => setTableName(e.target.value)}
                    autoFocus
                  />
                </label>
                {columns.map((c, i) => (
                  <div className="column-design" key={i}>
                    <input
                      aria-label={`Column ${i + 1} name`}
                      value={c.name}
                      onChange={(e) =>
                        setColumns((x) =>
                          x.map((v, j) => (j === i ? { ...v, name: e.target.value } : v)),
                        )
                      }
                    />
                    <select
                      value={c.type}
                      onChange={(e) =>
                        setColumns((x) =>
                          x.map((v, j) => (j === i ? { ...v, type: e.target.value } : v)),
                        )
                      }
                    >
                      <option>INTEGER</option>
                      <option>REAL</option>
                      <option>TEXT</option>
                      <option>BLOB</option>
                      <option>NUMERIC</option>
                    </select>
                    <label>
                      <input
                        type="checkbox"
                        checked={c.pk}
                        onChange={(e) =>
                          setColumns((x) =>
                            x.map((v, j) => (j === i ? { ...v, pk: e.target.checked } : v)),
                          )
                        }
                      />
                      Primary key
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={c.nullable}
                        onChange={(e) =>
                          setColumns((x) =>
                            x.map((v, j) => (j === i ? { ...v, nullable: e.target.checked } : v)),
                          )
                        }
                      />
                      Nullable
                    </label>
                    <button onClick={() => setColumns((x) => x.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </button>
                  </div>
                ))}
                <button
                  onClick={() =>
                    setColumns((x) => [...x, { name: "", type: "TEXT", pk: false, nullable: true }])
                  }
                >
                  <Plus />
                  Add column
                </button>
                <div>
                  <button onClick={() => setDesigner(false)}>Cancel</button>
                  <button className="save" onClick={createTable}>
                    Create table
                  </button>
                </div>
              </div>
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
                      disabled={!offset}
                      onClick={() => setOffset((x) => Math.max(0, x - 100))}
                    >
                      ‹
                    </button>
                    <button
                      disabled={!page || offset + 100 >= page.total}
                      onClick={() => setOffset((x) => x + 100)}
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

type SchemaNodeData = { schema: DbSchema; count: number | null; selected: boolean };
const handleId = (column: string, direction: "source" | "target") =>
  `${column.toLowerCase().replaceAll(" ", "-")}-${direction}`;
function SchemaNode({ data }: NodeProps<Node<SchemaNodeData>>) {
  return (
    <div className={`flow-table ${data.selected ? "active" : ""}`}>
      <div className="flow-table-head">
        <Table2 />
        <strong>{data.schema.name}</strong>
      </div>
      {data.schema.columns.map((column) => (
        <div className="flow-field" key={column.name}>
          <Handle id={handleId(column.name, "target")} type="target" position={Position.Left} />
          <span>{column.primaryKeyPosition ? "🔑" : "#"}</span>
          {column.name}
          <em>
            {column.primaryKeyPosition
              ? "PK"
              : data.schema.foreignKeys.some((key) => key.fromColumns.includes(column.name))
                ? "FK"
                : ""}
          </em>
          <Handle id={handleId(column.name, "source")} type="source" position={Position.Right} />
        </div>
      ))}
    </div>
  );
}
function RelationshipBrowser({
  objects,
  schemas,
  selected,
  onSelect,
}: {
  objects: DbObject[];
  schemas: DbSchema[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  const nodeTypes = useMemo(() => ({ table: SchemaNode }), []);
  const nodes = useMemo<Node<SchemaNodeData>[]>(
    () =>
      schemas.map((schema, index) => ({
        id: schema.name,
        type: "table",
        position: { x: 30 + (index % 3) * 300, y: 25 + Math.floor(index / 3) * 190 },
        data: {
          schema,
          count: objects.find((object) => object.name === schema.name)?.rowCount ?? null,
          selected: schema.name === selected,
        },
      })),
    [objects, schemas, selected],
  );
  const edges = useMemo<Edge[]>(
    () =>
      schemas.flatMap((schema) =>
        schema.foreignKeys.map((key) => ({
          id: `${schema.name}-${key.id}`,
          source: key.targetTable,
          sourceHandle: handleId(key.targetColumns[0] ?? "", "source"),
          target: schema.name,
          targetHandle: handleId(key.fromColumns[0] ?? "", "target"),
          label: "1 — ∞",
        })),
      ),
    [schemas],
  );
  return (
    <div className="flow-browser">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => onSelect(node.data.schema.name)}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.5}
        maxZoom={1.4}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => (node.data.selected ? "#52785d" : "#cdd7ce")}
          maskColor="#f4f6f2bb"
        />
      </ReactFlow>
    </div>
  );
}
function ResultGrid({ result }: { result: { columns: string[]; rows: DataValue[][] } | null }) {
  if (!result)
    return (
      <div className="empty-recent">
        <Code2 />
        <b>Run a query to see results</b>
      </div>
    );
  return (
    <div className="data-grid">
      <table>
        <thead>
          <tr>
            {result.columns.map((c, i) => (
              <th key={`${c}-${i}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j}>{showValue(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!result.rows.length && (
        <div className="empty-recent">
          <Rows3 />
          <b>Query returned no rows</b>
        </div>
      )}
    </div>
  );
}

function DesignStudio({ preview }: { preview: boolean }) {
  if (preview)
    return (
      <section className="app-preview" aria-label="Published inventory app">
        <div className="preview-app-head">
          <div>
            <small>INVENTORY APP</small>
            <h2>Products</h2>
          </div>
          <button>
            <Plus />
            Add product
          </button>
        </div>
        <div className="preview-metrics">
          <div>
            <small>TOTAL VALUE</small>
            <b>$48,290</b>
          </div>
          <div>
            <small>LOW STOCK</small>
            <b>3</b>
          </div>
          <div>
            <small>CATEGORIES</small>
            <b>8</b>
          </div>
        </div>
        <div className="preview-toolbar">
          <label>
            <Search />
            <input placeholder="Search inventory" />
          </label>
          <button>
            All categories <ChevronDown />
          </button>
        </div>
        <div className="preview-records">
          <div className="preview-record-head">
            <span>PRODUCT</span>
            <span>CATEGORY</span>
            <span>STOCK</span>
            <span>STATUS</span>
          </div>
          {[
            ["Ceramic Pour-over Set", "Kitchen", "24", "In stock"],
            ["Linen Table Runner", "Textiles", "7", "Low stock"],
            ["Oak Serving Board", "Kitchen", "16", "In stock"],
            ["Brass Desk Lamp", "Lighting", "31", "In stock"],
          ].map((row) => (
            <div className="preview-record" key={row[0]}>
              {row.map((cell, index) => (
                <span className={index === 3 ? "record-status" : ""} key={cell}>
                  {cell}
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>
    );
  return (
    <section className="form-studio" aria-label="Product form builder">
      <aside className="studio-components">
        <small>COMPONENTS</small>
        <button>
          <Rows3 />
          Text field
        </button>
        <button>
          <ListFilter />
          Select
        </button>
        <button>
          <Columns3 />
          Number
        </button>
        <button>
          <Shapes />
          Section
        </button>
      </aside>
      <div className="studio-canvas">
        <div className="form-card">
          <small>PRODUCT FORM</small>
          <h2>Product details</h2>
          <p>Create and edit product information.</p>
          <label>
            Name <span>Enter product name</span>
          </label>
          <label>
            Category{" "}
            <span>
              Select category <ChevronDown />
            </span>
          </label>
          <div className="studio-field-row">
            <label>
              Price <span>$ 0.00</span>
            </label>
            <label>
              Stock <span>0</span>
            </label>
          </div>
          <div className="form-actions">
            <button>Cancel</button>
            <button className="save">Save product</button>
          </div>
        </div>
        <button className="add-section">
          <Plus />
          Add section
        </button>
      </div>
      <aside className="studio-properties">
        <small>PROPERTIES</small>
        <b>Form</b>
        <label>
          Layout
          <span>
            Single column <ChevronDown />
          </span>
        </label>
        <label>
          Spacing
          <span>
            Comfortable <ChevronDown />
          </span>
        </label>
        <label>
          Permissions
          <span>
            Team members <ChevronDown />
          </span>
        </label>
      </aside>
    </section>
  );
}

function RibbonGroup({
  label,
  items,
  action,
}: {
  label: string;
  items: Array<[LucideIcon, string]>;
  action: (name: string) => void;
}) {
  return (
    <div className="ribbon-group">
      <div className="ribbon-tools">
        {items.map(([Icon, name]) => (
          <button key={name} onClick={() => action(name)}>
            <Icon />
            <span>{name}</span>
          </button>
        ))}
      </div>
      <small>{label}</small>
    </div>
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
