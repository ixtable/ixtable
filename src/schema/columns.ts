import type { CreateColumnSpec, DbColumn, TableSchema } from "../lib/types";
import { logicalOf } from "./logical";

/** Editable column definition shared by the create form and the table designer. */
export interface ColumnDraft {
  name: string;
  logicalType: string;
  required: boolean;
  defaultExpression: string;
  unique: boolean;
  check: string;
}

export const emptyColumn = (name = ""): ColumnDraft => ({
  name,
  logicalType: "text",
  required: false,
  defaultExpression: "",
  unique: false,
  check: "",
});

export const draftFromColumn = (column: DbColumn, schema: TableSchema): ColumnDraft => ({
  name: column.name,
  logicalType: logicalOf(column),
  required: !column.nullable,
  defaultExpression: column.defaultValue ?? "",
  unique:
    column.unique ??
    (schema.uniques ?? []).some((u) => u.columns.length === 1 && u.columns[0] === column.name),
  check: columnCheck(schema, column.name),
});

/** Lower-cased identifiers an expression mentions, skipping string literals. */
const identifiers = (expression: string): Set<string> => {
  const out = new Set<string>();
  for (const m of expression.matchAll(/'(?:[^']|'')*'|"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2];
    if (name !== undefined) out.add(name.toLowerCase());
  }
  return out;
};

/**
 * The column's own check: table checks that mention this column and no other.
 * Mirrors `column_checks`/`joined_check` in `src-tauri/src/recordstore/plan.rs`,
 * so the designer shows exactly what `alter_column` would keep or replace.
 */
export const columnCheck = (schema: TableSchema, column: string): string => {
  const self = column.toLowerCase();
  const others = schema.columns.map((c) => c.name.toLowerCase()).filter((c) => c !== self);
  const owned = (schema.checks ?? [])
    .map((c) => c.expression.trim())
    .filter((e) => {
      const ids = identifiers(e);
      return ids.has(self) && !others.some((o) => ids.has(o));
    });
  return owned.length === 1 ? owned[0] : owned.map((e) => `(${e})`).join(" AND ");
};

export const specFromDraft = (draft: ColumnDraft, primaryKeyPosition = 0): CreateColumnSpec => ({
  name: draft.name.trim(),
  declaredType: "",
  logicalType: draft.logicalType,
  nullable: !draft.required,
  primaryKeyPosition,
  unique: draft.unique,
  defaultExpression: draft.defaultExpression.trim() || null,
  generatedExpression: null,
  check: draft.check.trim() || null,
});
