import { Plus } from "lucide-react";
import { useState } from "react";
import type { AlterTableOperation, CreateColumnSpec, DbColumn, TableSchema } from "../lib/types";

export function TableSchemaDesigner({
  schema,
  loading,
  error,
  onApply,
  onCancel,
}: {
  schema: TableSchema;
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
        `Drop column “${column.name}”? This destructive change permanently deletes its data.${detail}`,
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
            Edit columns, constraints, and relationships using typed record-store operations.
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
            In-place schema change
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
              aria-label={`Rename column ${column.name}`}
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
            In-place schema change
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
          Relationship additions, removals, and action changes are previewed as table-rebuild
          migrations. They are not in-place schema changes.
        </p>
      </section>
    </div>
  );
}
