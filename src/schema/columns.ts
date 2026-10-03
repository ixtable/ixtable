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
  check: "",
});

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
