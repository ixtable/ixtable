import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { CreateTableSpec } from "../lib/types";

type ColumnDraft = { name: string; type: string; pk: boolean; nullable: boolean };
const TYPES = ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"];

export function CreateTableForm({
  onCreate,
  onCancel,
}: {
  onCreate: (spec: CreateTableSpec) => Promise<void>;
  onCancel: () => void;
}) {
  const [tableName, setTableName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [columns, setColumns] = useState<ColumnDraft[]>([
    { name: "id", type: "INTEGER", pk: true, nullable: false },
    { name: "name", type: "TEXT", pk: false, nullable: true },
  ]);
  const change = (index: number, patch: Partial<ColumnDraft>) =>
    setColumns((items) => items.map((item, j) => (j === index ? { ...item, ...patch } : item)));
  const submit = async () => {
    if (!tableName.trim() || !columns.length || columns.some((c) => !c.name.trim())) {
      setError("Table and column names are required.");
      return;
    }
    setBusy(true);
    setError("");
    let position = 0;
    try {
      await onCreate({
        name: tableName.trim(),
        columns: columns.map((c) => ({
          name: c.name.trim(),
          declaredType: c.type,
          nullable: c.nullable,
          primaryKeyPosition: c.pk ? ++position : 0,
          unique: false,
          defaultExpression: null,
          generatedExpression: null,
        })),
        foreignKeys: [],
        checks: [],
        withoutRowid: false,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="table-designer"
      aria-label="Create table"
      onSubmit={(event) => {
        event.preventDefault();
        submit().catch(() => undefined);
      }}
    >
      <h2>Create table</h2>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <label>
        Table name
        <input value={tableName} onChange={(e) => setTableName(e.target.value)} autoFocus />
      </label>
      {columns.map((c, i) => (
        <div className="column-design" key={i}>
          <input
            aria-label={`Column ${i + 1} name`}
            value={c.name}
            onChange={(e) => change(i, { name: e.target.value })}
          />
          <select
            aria-label={`Column ${i + 1} type`}
            value={c.type}
            onChange={(e) => change(i, { type: e.target.value })}
          >
            {TYPES.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
          <label>
            <input
              type="checkbox"
              aria-label={`Column ${i + 1} primary key`}
              checked={c.pk}
              onChange={(e) => change(i, { pk: e.target.checked })}
            />
            Primary key
          </label>
          <label>
            <input
              type="checkbox"
              aria-label={`Column ${i + 1} nullable`}
              checked={c.nullable}
              onChange={(e) => change(i, { nullable: e.target.checked })}
            />
            Nullable
          </label>
          <button
            type="button"
            aria-label={`Remove column ${i + 1}`}
            onClick={() => setColumns((items) => items.filter((_, j) => j !== i))}
          >
            <Trash2 />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setColumns((items) => [...items, { name: "", type: "TEXT", pk: false, nullable: true }])
        }
      >
        <Plus />
        Add column
      </button>
      <div>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="save" disabled={busy}>
          Create table
        </button>
      </div>
    </form>
  );
}
