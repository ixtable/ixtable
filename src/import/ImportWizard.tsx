import { FileUp } from "lucide-react";
import { useId, useState } from "react";
import { DialogFrame } from "../components/DialogFrame";
import { showValue } from "../data/format";
import { asTauriError, type TauriError } from "../lib/api";
import type { TableSchema } from "../lib/types";
import { importFile, previewImportFile } from "./api";
import { chooseFileToImport } from "./dialog";
import { FieldMappingEditor, NewTableColumns } from "./ImportTargetEditor";
import {
  type ColumnDraft,
  cleanOptions,
  defaultColumns,
  defaultMapping,
  defaultOptions,
  defaultPrimaryKey,
  existingTableTarget,
  type FieldDrafts,
  nameFromPath,
  newTableTarget,
} from "./mapping";
import type { FilePreview, ImportReport, ParseOptions } from "./types";

const PREVIEW_SHOWN = 10;

/**
 * Import wizard (PRD §3.2): choose a CSV, XLSX, JSON, or Parquet file, check
 * the preview and inferred types, map it to a new or existing table, and
 * import. Rows are written through the RecordStore; rows that fail a type or
 * constraint check are listed in the report and skipped.
 */
export function ImportWizard({
  tables,
  onClose,
  onImported,
}: {
  tables: TableSchema[];
  onClose: () => void;
  onImported: (table: string) => Promise<void>;
}) {
  const titleId = useId();
  const [path, setPath] = useState("");
  const [options, setOptions] = useState<ParseOptions>(defaultOptions);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [tableName, setTableName] = useState("");
  const [columns, setColumns] = useState<ColumnDraft[]>([]);
  const [primaryKey, setPrimaryKey] = useState("");
  const [existing, setExisting] = useState(tables[0]?.name ?? "");
  const [mapping, setMapping] = useState<FieldDrafts>({});
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TauriError | null>(null);

  const load = async (file: string, next: ParseOptions) => {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const result = await previewImportFile(file, cleanOptions(next));
      const drafts = defaultColumns(result);
      setPreview(result);
      setColumns(drafts);
      setPrimaryKey(defaultPrimaryKey(drafts));
      setMapping(
        defaultMapping(
          result,
          tables.find((t) => t.name === existing),
        ),
      );
    } catch (reason) {
      setPreview(null);
      setError(asTauriError(reason));
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    const file = await chooseFileToImport();
    if (!file) return;
    const next = defaultOptions();
    setPath(file);
    setOptions(next);
    setTableName(nameFromPath(file));
    await load(file, next);
  };
  const changeOptions = (patch: Partial<ParseOptions>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    if (path) void load(path, next);
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const target =
        mode === "new"
          ? newTableTarget(tableName, columns, primaryKey)
          : existingTableTarget(existing, mapping);
      const result = await importFile(path, cleanOptions(options), target);
      setReport(result);
      await onImported(result.table);
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="schema-dialog-backdrop">
      <DialogFrame
        className="schema-dialog import-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClose={onClose}
        busy={busy}
      >
        <h2 id={titleId}>Import records</h2>
        <div className="settings-actions">
          <button type="button" disabled={busy} onClick={() => void choose()} data-autofocus>
            <FileUp aria-hidden /> Choose file…
          </button>
          <span>{path ? path.split(/[\\/]/).pop() : "CSV, XLSX, JSON, or Parquet"}</span>
        </div>
        {preview && (preview.format === "csv" || preview.format === "xlsx") && (
          <fieldset className="import-options" disabled={busy}>
            <legend>File options</legend>
            <label>
              <input
                type="checkbox"
                checked={options.header}
                onChange={(e) => changeOptions({ header: e.target.checked })}
              />{" "}
              First row has column names
            </label>
            {preview.format === "csv" && (
              <label>
                Delimiter{" "}
                <input
                  aria-label="Delimiter"
                  placeholder="Detect"
                  maxLength={1}
                  size={6}
                  value={options.delimiter ?? ""}
                  onChange={(e) => changeOptions({ delimiter: e.target.value })}
                />
              </label>
            )}
            {preview.format === "xlsx" && (
              <label>
                Worksheet{" "}
                <select
                  value={options.sheet || preview.sheets[0]}
                  onChange={(e) => changeOptions({ sheet: e.target.value })}
                >
                  {preview.sheets.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
        )}
        {preview && (
          <>
            <p role="status">
              {preview.totalRows.toLocaleString()} rows · showing the first{" "}
              {Math.min(PREVIEW_SHOWN, preview.rows.length)}
            </p>
            <div className="import-preview">
              <table className="asset-table" aria-label="File preview">
                <thead>
                  <tr>
                    {preview.columns.map((c) => (
                      <th scope="col" key={c.name}>
                        {c.name} <small>{c.logicalType}</small>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, PREVIEW_SHOWN).map((row, i) => (
                    <tr key={i}>
                      {row.map((v, j) => (
                        <td key={j}>{showValue(v)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <fieldset className="import-options" disabled={busy}>
              <legend>Import into</legend>
              <label>
                <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} /> A
                new table
              </label>
              <label>
                <input
                  type="radio"
                  checked={mode === "existing"}
                  disabled={!tables.length}
                  onChange={() => setMode("existing")}
                />{" "}
                An existing table
              </label>
            </fieldset>
            {mode === "new" ? (
              <>
                <label className="grid gap-1">
                  Table name
                  <input value={tableName} onChange={(e) => setTableName(e.target.value)} />
                </label>
                <NewTableColumns
                  columns={columns}
                  primaryKey={primaryKey}
                  onColumns={setColumns}
                  onPrimaryKey={setPrimaryKey}
                />
              </>
            ) : (
              <>
                <label className="grid gap-1">
                  Table
                  <select
                    value={existing}
                    onChange={(e) => {
                      setExisting(e.target.value);
                      setMapping(
                        defaultMapping(
                          preview,
                          tables.find((t) => t.name === e.target.value),
                        ),
                      );
                    }}
                  >
                    {tables.map((t) => (
                      <option key={t.name}>{t.name}</option>
                    ))}
                  </select>
                </label>
                <FieldMappingEditor
                  preview={preview}
                  table={tables.find((t) => t.name === existing)}
                  mapping={mapping}
                  onMapping={setMapping}
                />
              </>
            )}
          </>
        )}
        {error && (
          <div className="error" role="alert">
            <b>{error.code}</b> <span>{error.message}</span>
          </div>
        )}
        {report && <ReportView report={report} />}
        <div className="settings-actions">
          <button
            type="button"
            className="save"
            disabled={busy || !preview || !!report}
            onClick={() => void run()}
          >
            {busy && preview ? "Importing…" : "Import"}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            {report ? "Done" : "Cancel"}
          </button>
        </div>
      </DialogFrame>
    </div>
  );
}

function ReportView({ report }: { report: ImportReport }) {
  return (
    <section aria-label="Import report">
      <p role="status">
        Imported {report.imported.toLocaleString()} of {report.totalRows.toLocaleString()} rows into{" "}
        {report.table}.
        {report.failed > 0 && ` ${report.failed.toLocaleString()} rows were skipped.`}
      </p>
      {report.errors.length > 0 && (
        <table className="asset-table" aria-label="Rows not imported">
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">Field</th>
              <th scope="col">Problem</th>
            </tr>
          </thead>
          <tbody>
            {report.errors.map((e, i) => (
              <tr key={i}>
                <td>{e.row}</td>
                <td>{e.column ?? "—"}</td>
                <td>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.failed > report.errors.length && (
        <p>Only the first {report.errors.length} problems are listed.</p>
      )}
    </section>
  );
}
