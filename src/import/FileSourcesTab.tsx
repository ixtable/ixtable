import { FileUp, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { asTauriError, type TauriError } from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import { importAsset } from "../persistence/api";
import { useShell } from "../shell/context";
import { fileSourceInfo, previewImportFile } from "./api";
import { chooseFileSource } from "./dialog";
import { cleanOptions, defaultOptions, nameFromPath } from "./mapping";
import type { FilePreview, FileSource, FileSourceInfo, ParseOptions } from "./types";

interface Pending {
  path: string;
  name: string;
  options: ParseOptions;
  preview: FilePreview;
}

/**
 * Bundled read-only file sources (PRD §10): a CSV, JSON, or Parquet file is
 * stored in the archive as an asset and read by queries, reports, and
 * dashboards as `files.<name>`.
 */
export function FileSourcesTab() {
  const { applySession } = useShell();
  const { config, update, settled } = useDocumentConfig();
  const sources = config.fileSources ?? [];
  const [info, setInfo] = useState<FileSourceInfo[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TauriError | null>(null);
  const [status, setStatus] = useState("");

  // Waits for queued config edits so Rust reads the sources the UI shows.
  const refresh = useCallback(async () => {
    await settled();
    setInfo(await fileSourceInfo());
  }, [settled]);
  useEffect(() => {
    refresh().catch((reason: unknown) => setError(asTauriError(reason)));
  }, [refresh, config.fileSources]);

  const act = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      setStatus(await action());
    } catch (reason) {
      setError(asTauriError(reason));
    } finally {
      setBusy(false);
    }
  };
  const load = (path: string, name: string, options: ParseOptions) =>
    act(async () => {
      const preview = await previewImportFile(path, cleanOptions(options));
      if (preview.format === "xlsx") throw new Error("Import XLSX files into a table instead.");
      setPending({ path, name, options, preview });
      return "";
    });
  const choose = async () => {
    const path = await chooseFileSource();
    if (path) await load(path, nameFromPath(path), defaultOptions());
  };
  const add = (p: Pending) =>
    act(async () => {
      const { asset, state } = await importAsset(p.path);
      applySession(state);
      const clean = cleanOptions(p.options);
      const source: FileSource = {
        id: crypto.randomUUID(),
        name: p.name,
        assetId: asset.id,
        format: p.preview.format,
        csv: { header: clean.header, delimiter: clean.delimiter },
      };
      await update(
        (draft) => ({ ...draft, fileSources: [...(draft.fileSources ?? []), source] }),
        `Add file source ${p.name}`,
      );
      setPending(null);
      return `Added files.${p.name}.`;
    });
  const remove = (source: FileSource) =>
    act(async () => {
      await update(
        (draft) => ({
          ...draft,
          fileSources: (draft.fileSources ?? []).filter((s) => s.id !== source.id),
        }),
        `Remove file source ${source.name}`,
      );
      return `Removed files.${source.name}. Its file stays in Assets until you remove unused assets.`;
    });

  return (
    <div className="settings-panel">
      <h2>File sources</h2>
      <p>
        CSV, JSON, and Parquet files stored inside this application and read like tables. Query them
        as <code>files.&lt;name&gt;</code> in saved queries, reports, and dashboards. They are
        read-only; to edit the rows, import the file into a table instead.
      </p>
      <div className="settings-actions">
        <button className="save" disabled={busy} onClick={() => void choose()}>
          <FileUp aria-hidden /> Add file source
        </button>
      </div>
      {pending && (
        <fieldset className="import-options" disabled={busy}>
          <legend>New file source</legend>
          <label className="grid gap-1">
            Source name
            <input
              value={pending.name}
              onChange={(e) => setPending({ ...pending, name: e.target.value })}
            />
          </label>
          {pending.preview.format === "csv" && (
            <label>
              <input
                type="checkbox"
                checked={pending.options.header}
                onChange={(e) =>
                  void load(pending.path, pending.name, {
                    ...pending.options,
                    header: e.target.checked,
                  })
                }
              />{" "}
              First row has column names
            </label>
          )}
          <p role="status">
            {pending.preview.totalRows.toLocaleString()} rows ·{" "}
            {pending.preview.columns.map((c) => `${c.name} (${c.logicalType})`).join(", ")}
          </p>
          <div className="settings-actions">
            <button className="save" onClick={() => void add(pending)}>
              Add source
            </button>
            <button onClick={() => setPending(null)}>Cancel</button>
          </div>
        </fieldset>
      )}
      {error && (
        <div className="error" role="alert">
          <b>{error.code}</b> <span>{error.message}</span>
        </div>
      )}
      {status && <p role="status">{status}</p>}
      {sources.length > 0 ? (
        <table className="asset-table" aria-label="File sources">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Format</th>
              <th scope="col">Columns</th>
              <th scope="col">Rows</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => {
              const details = info.find((i) => i.id === source.id);
              return (
                <tr key={source.id}>
                  <td>
                    <code>files.{source.name}</code>
                  </td>
                  <td>{source.format.toUpperCase()}</td>
                  <td>
                    {details?.error ? (
                      <span role="alert">{details.error}</span>
                    ) : (
                      details?.columns.map((c) => c.name).join(", ")
                    )}
                  </td>
                  <td>{details?.rowCount?.toLocaleString() ?? "—"}</td>
                  <td>
                    <button
                      disabled={busy}
                      aria-label={`Remove ${source.name}`}
                      onClick={() => void remove(source)}
                    >
                      <Trash2 aria-hidden />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p>No file sources yet.</p>
      )}
    </div>
  );
}
