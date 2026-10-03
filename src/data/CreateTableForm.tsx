import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { CreateForeignKeySpec, CreateTableSpec, TableSchema } from "../lib/types";
import { ColumnFields } from "../schema/ColumnFields";
import { type ColumnDraft, emptyColumn, specFromDraft } from "../schema/columns";
import {
  CheckEditor,
  ForeignKeyEditor,
  IndexEditor,
  UniqueEditor,
} from "../schema/ConstraintEditors";
import "../schema/schema.css";

type Row = ColumnDraft & { pk: boolean };

/** Create-table form: logical types, keys (including composite), relationships, constraints, indexes. */
export function CreateTableForm({
  onCreate,
  onCancel,
  tables = [],
  maxPrecision,
}: {
  onCreate: (spec: CreateTableSpec) => Promise<void>;
  onCancel: () => void;
  tables?: TableSchema[];
  maxPrecision?: number;
}) {
  const [tableName, setTableName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [columns, setColumns] = useState<Row[]>([
    { ...emptyColumn("id"), logicalType: "integer", required: true, pk: true },
    { ...emptyColumn("name"), pk: false },
  ]);
  const [foreignKeys, setForeignKeys] = useState<CreateForeignKeySpec[]>([]);
  const [uniques, setUniques] = useState<string[][]>([]);
  const [checks, setChecks] = useState<string[]>([]);
  const [indexes, setIndexes] = useState<
    Array<{ name: string; columns: string[]; unique: boolean }>
  >([]);
  const names = columns.map((c) => c.name.trim()).filter(Boolean);
  const change = (index: number, patch: Partial<Row>) =>
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
        columns: columns.map((c) => specFromDraft(c, c.pk ? ++position : 0)),
        foreignKeys,
        checks,
        withoutRowid: false,
        uniques,
        indexes,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const targets = [
    ...tables,
    {
      name: tableName.trim() || "this table",
      columns: names.map((name) => ({ name })),
    } as TableSchema,
  ];
  return (
    <form
      className="table-designer schema-designer"
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
      <section aria-label="Columns">
        <h3>Columns</h3>
        {columns.map((c, i) => (
          <div className="flex flex-wrap items-center gap-2" key={i}>
            <ColumnFields
              draft={c}
              label={`Column ${i + 1}`}
              maxPrecision={maxPrecision}
              onChange={(next) => change(i, next)}
            />
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                aria-label={`Column ${i + 1} primary key`}
                checked={c.pk}
                onChange={(e) =>
                  change(i, { pk: e.target.checked, required: e.target.checked || c.required })
                }
              />
              Primary key
            </label>
            <button
              type="button"
              aria-label={`Remove column ${i + 1}`}
              onClick={() => setColumns((items) => items.filter((_, j) => j !== i))}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setColumns((items) => [...items, { ...emptyColumn(), pk: false }])}
        >
          <Plus aria-hidden="true" />
          Add column
        </button>
      </section>
      <section aria-label="Relationships">
        <h3>Relationships</h3>
        <ul>
          {foreignKeys.map((f, i) => (
            <li key={i}>
              ({f.columns.join(", ")}) → {f.targetTable} ({f.targetColumns.join(", ")}) · update{" "}
              {f.onUpdate} · delete {f.onDelete}{" "}
              <button
                type="button"
                onClick={() => setForeignKeys((x) => x.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <ForeignKeyEditor
          columns={names}
          tables={targets}
          onAdd={(fk) =>
            setForeignKeys((x) => [
              ...x,
              {
                ...fk,
                targetTable: fk.targetTable === "this table" ? tableName.trim() : fk.targetTable,
              },
            ])
          }
        />
      </section>
      <section aria-label="Constraints and indexes">
        <h3>Constraints and indexes</h3>
        <ul>
          {uniques.map((u, i) => (
            <li key={`u${i}`}>Unique ({u.join(", ")})</li>
          ))}
          {checks.map((c, i) => (
            <li key={`c${i}`}>Check ({c})</li>
          ))}
          {indexes.map((x) => (
            <li key={x.name}>
              {x.unique ? "Unique index" : "Index"} {x.name} ({x.columns.join(", ")})
            </li>
          ))}
        </ul>
        <UniqueEditor columns={names} onAdd={(cols) => setUniques((x) => [...x, cols])} />
        <CheckEditor onAdd={(expr) => setChecks((x) => [...x, expr])} />
        <IndexEditor
          table={tableName.trim() || "table"}
          columns={names}
          onAdd={(index) => setIndexes((x) => [...x, index])}
        />
      </section>
      <div className="settings-actions">
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
