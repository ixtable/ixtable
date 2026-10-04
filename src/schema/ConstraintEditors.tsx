import { Plus } from "lucide-react";
import { useId, useState } from "react";
import type { CreateForeignKeySpec, TableSchema } from "../lib/types";

const ACTIONS = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];

/** Ordered multi-column choice: columns are listed in the order they were ticked. */
export function ColumnPicker({
  label,
  columns,
  selected,
  onChange,
}: {
  label: string;
  columns: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="column-picker">
      <legend>{label}</legend>
      {columns.map((c) => (
        <label key={c}>
          <input
            type="checkbox"
            aria-label={`${label}: ${c}`}
            checked={selected.includes(c)}
            onChange={(e) =>
              onChange(e.target.checked ? [...selected, c] : selected.filter((x) => x !== c))
            }
          />
          {c}
          {selected.includes(c) && selected.length > 1 && <small>#{selected.indexOf(c) + 1}</small>}
        </label>
      ))}
    </fieldset>
  );
}

/** Builds a (possibly composite) foreign key with referential actions. */
export function ForeignKeyEditor({
  columns,
  tables,
  onAdd,
}: {
  columns: string[];
  tables: Array<Pick<TableSchema, "name" | "columns">>;
  onAdd: (fk: CreateForeignKeySpec) => void;
}) {
  const [source, setSource] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [onUpdate, setOnUpdate] = useState("NO ACTION");
  const [onDelete, setOnDelete] = useState("NO ACTION");
  const targetColumns = tables.find((t) => t.name === target)?.columns.map((c) => c.name) ?? [];
  const ready = source.length > 0 && target && source.every((c) => targets[c]);
  return (
    <fieldset className="constraint-editor">
      <legend>New relationship</legend>
      <ColumnPicker
        label="Relationship columns"
        columns={columns}
        selected={source}
        onChange={setSource}
      />
      <label>
        Target table
        <select
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setTargets({});
          }}
        >
          <option value="">Choose a table</option>
          {tables.map((t) => (
            <option key={t.name}>{t.name}</option>
          ))}
        </select>
      </label>
      {source.map((c) => (
        <label key={c}>
          Target column for {c}
          <select
            value={targets[c] ?? ""}
            onChange={(e) => setTargets((x) => ({ ...x, [c]: e.target.value }))}
          >
            <option value="">Choose a column</option>
            {targetColumns.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      ))}
      <label>
        On update
        <select value={onUpdate} onChange={(e) => setOnUpdate(e.target.value)}>
          {ACTIONS.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </label>
      <label>
        On delete
        <select value={onDelete} onChange={(e) => setOnDelete(e.target.value)}>
          {ACTIONS.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!ready}
        onClick={() => {
          onAdd({
            columns: source,
            targetTable: target,
            targetColumns: source.map((c) => targets[c]),
            onUpdate,
            onDelete,
          });
          setSource([]);
          setTargets({});
        }}
      >
        <Plus aria-hidden="true" />
        Add relationship
      </button>
    </fieldset>
  );
}

/** Multi-column unique constraint builder. */
export function UniqueEditor({
  columns,
  onAdd,
}: {
  columns: string[];
  onAdd: (columns: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <fieldset className="constraint-editor">
      <legend>New unique constraint</legend>
      <ColumnPicker
        label="Unique columns"
        columns={columns}
        selected={selected}
        onChange={setSelected}
      />
      <button
        type="button"
        disabled={!selected.length}
        onClick={() => {
          onAdd(selected);
          setSelected([]);
        }}
      >
        <Plus aria-hidden="true" />
        Add unique constraint
      </button>
    </fieldset>
  );
}

export function CheckEditor({ onAdd }: { onAdd: (expression: string) => void }) {
  const [expression, setExpression] = useState("");
  const id = useId();
  return (
    <div className="constraint-editor flex flex-wrap items-center gap-2">
      <label htmlFor={id}>Check expression</label>
      <input
        id={id}
        placeholder="e.g. end_date >= start_date"
        value={expression}
        onChange={(e) => setExpression(e.target.value)}
      />
      <button
        type="button"
        disabled={!expression.trim()}
        onClick={() => {
          onAdd(expression.trim());
          setExpression("");
        }}
      >
        <Plus aria-hidden="true" />
        Add check
      </button>
    </div>
  );
}

/** Unique or non-unique, single or multi-column index builder. */
export function IndexEditor({
  table,
  columns,
  onAdd,
}: {
  table: string;
  columns: string[];
  onAdd: (index: { name: string; columns: string[]; unique: boolean }) => void;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const suggested = `${table}_${selected.join("_") || "idx"}`.toLowerCase().replace(/\W+/g, "_");
  return (
    <fieldset className="constraint-editor">
      <legend>New index</legend>
      <label>
        Index name
        <input value={name} placeholder={suggested} onChange={(e) => setName(e.target.value)} />
      </label>
      <ColumnPicker
        label="Index columns"
        columns={columns}
        selected={selected}
        onChange={setSelected}
      />
      <label>
        <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
        Unique index
      </label>
      <button
        type="button"
        disabled={!selected.length}
        onClick={() => {
          onAdd({ name: name.trim() || suggested, columns: selected, unique });
          setName("");
          setSelected([]);
          setUnique(false);
        }}
      >
        <Plus aria-hidden="true" />
        Add index
      </button>
    </fieldset>
  );
}
