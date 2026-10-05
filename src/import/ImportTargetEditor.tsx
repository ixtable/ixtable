import type { TableSchema } from "../lib/types";
import { LOGICAL_TYPES } from "../schema/logical";
import type { ColumnDraft, FieldDrafts } from "./mapping";
import type { FilePreview } from "./types";

const typeLabel = (type: string) =>
  LOGICAL_TYPES.find((t) => t.value === type.replace(/\(.*$/, ""))?.label ?? type;

/** New-table columns: include, name, type, and the primary key. */
export function NewTableColumns({
  columns,
  primaryKey,
  onColumns,
  onPrimaryKey,
}: {
  columns: ColumnDraft[];
  primaryKey: string;
  onColumns: (columns: ColumnDraft[]) => void;
  onPrimaryKey: (name: string) => void;
}) {
  const change = (i: number, patch: Partial<ColumnDraft>) =>
    onColumns(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <>
      <table className="asset-table" aria-label="New table columns">
        <thead>
          <tr>
            <th scope="col">Import</th>
            <th scope="col">File column</th>
            <th scope="col">Field name</th>
            <th scope="col">Type</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c, i) => (
            <tr key={c.source}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Import ${c.source}`}
                  checked={c.include}
                  onChange={(e) => change(i, { include: e.target.checked })}
                />
              </td>
              <td>{c.source}</td>
              <td>
                <input
                  aria-label={`Field name for ${c.source}`}
                  value={c.name}
                  disabled={!c.include}
                  onChange={(e) => change(i, { name: e.target.value })}
                />
              </td>
              <td>
                <select
                  aria-label={`Type for ${c.source}`}
                  value={c.logicalType}
                  disabled={!c.include}
                  onChange={(e) => change(i, { logicalType: e.target.value })}
                >
                  {!LOGICAL_TYPES.some((t) => t.value === c.logicalType) && (
                    <option value={c.logicalType}>{c.logicalType}</option>
                  )}
                  {LOGICAL_TYPES.filter((t) => t.value !== "decimal").map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className="grid gap-1">
        Primary key
        <select value={primaryKey} onChange={(e) => onPrimaryKey(e.target.value)}>
          <option value="">New id column (numbered automatically)</option>
          {columns
            .filter((c) => c.include)
            .map((c) => (
              <option key={c.source} value={c.name}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
    </>
  );
}

/** Existing-table mapping: each file column goes to a field or is skipped. */
export function FieldMappingEditor({
  preview,
  table,
  mapping,
  onMapping,
}: {
  preview: FilePreview;
  table: TableSchema | undefined;
  mapping: FieldDrafts;
  onMapping: (mapping: FieldDrafts) => void;
}) {
  const fields = (table?.columns ?? []).filter((c) => !c.generated);
  return (
    <table className="asset-table" aria-label="Column mapping">
      <thead>
        <tr>
          <th scope="col">File column</th>
          <th scope="col">Detected type</th>
          <th scope="col">Field</th>
        </tr>
      </thead>
      <tbody>
        {preview.columns.map((c) => (
          <tr key={c.name}>
            <td>{c.name}</td>
            <td>{typeLabel(c.logicalType)}</td>
            <td>
              <select
                aria-label={`Field for ${c.name}`}
                value={mapping[c.name] ?? ""}
                onChange={(e) => onMapping({ ...mapping, [c.name]: e.target.value })}
              >
                <option value="">Skip this column</option>
                {fields.map((f) => (
                  <option key={f.name} value={f.name}>
                    {f.name}
                    {!f.nullable && f.defaultValue === null && !f.autoIncrement
                      ? " (required)"
                      : ""}
                  </option>
                ))}
              </select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
