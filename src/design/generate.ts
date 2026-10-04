import { defaultGridLayout } from "../grid/engine";
import type { DbColumn, DbForeignKey, TableSchema } from "../lib/types";
import { newId } from "../lib/utils";
import { parseLogical } from "../schema/logical";
import {
  type ControlKind,
  type DesignControl,
  type DesignForm,
  type NavigationItem,
  newForm,
  nextPlacement,
} from "./schema";

/** "order_items" → "Order items", "customer_id" → "Customer id". */
export const humanize = (name: string) => {
  const text = name.replace(/[_-]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : name;
};

const LOGICAL_KINDS: Record<string, ControlKind | null> = {
  text: "text",
  uuid: "text",
  json: "multiline",
  integer: "number",
  real: "decimal",
  decimal: "decimal",
  boolean: "boolean",
  date: "date",
  time: "time",
  timestamp: "datetime",
  blob: null,
};

type TypedColumn = Pick<DbColumn, "declaredType"> & { logicalType?: string | null };

/**
 * Control kind for a column: its logical type (as `inspect_table` reports it, on any
 * backend) when known, else the declared SQL type by SQLite affinity rules plus date names.
 */
export function kindForColumn(column: TypedColumn): ControlKind | null {
  const logical = column.logicalType ? parseLogical(column.logicalType).base : null;
  if (logical && logical in LOGICAL_KINDS) return LOGICAL_KINDS[logical];
  const type = column.declaredType.toUpperCase();
  if (type.includes("BLOB")) return null;
  if (type.includes("BOOL")) return "boolean";
  if (type.includes("TIMESTAMP") || type.includes("DATETIME")) return "datetime";
  if (type.includes("DATE")) return "date";
  if (type.includes("TIME")) return "time";
  if (type.includes("INT")) return "number";
  if (/REAL|FLOA|DOUB|NUM|DEC|MONEY/.test(type)) return "decimal";
  return "text";
}

/** Display column for a lookup: the first text column that is not a key, else the key itself. */
export function displayColumnFor(target: TableSchema | undefined, fallback: string): string {
  const text = target?.columns.find(
    (column) => !column.primaryKeyPosition && kindForColumn(column) === "text",
  );
  return text?.name ?? fallback;
}

/**
 * True for a single integer primary key the database fills in on insert: SQLite's
 * `INTEGER PRIMARY KEY` (rowid alias), or a PostgreSQL identity column, which reports
 * the lowercase `format_type` name, a logical integer type, and no default expression.
 */
export const isAutoKey = (table: TableSchema, column: DbColumn) => {
  if (column.primaryKeyPosition <= 0) return false;
  if (table.columns.filter((c) => c.primaryKeyPosition > 0).length !== 1) return false;
  if (column.declaredType.toUpperCase() === "INTEGER") return true;
  return (
    !!column.logicalType &&
    parseLogical(column.logicalType).base === "integer" &&
    column.defaultValue == null &&
    /^(integer|bigint|smallint)$/.test(column.declaredType)
  );
};

export type GenerateOptions = {
  /** Schemas of tables referenced by foreign keys, used to pick lookup display columns. */
  targets?: Record<string, TableSchema>;
  /** Tables whose foreign keys point at this table; each becomes a related-record list. */
  children?: TableSchema[];
  /** Child table → form used to add and edit its rows in the related list. */
  childForms?: Record<string, string>;
};

export type GeneratedCrud = { list: DesignForm; detail: DesignForm; navigation: NavigationItem };

/** The foreign key whose selector edits `column`: a single-column key, else a multi-column one it leads. */
function keyFor(table: TableSchema, column: string): DbForeignKey | undefined {
  return (
    table.foreignKeys.find((fk) => fk.fromColumns.length === 1 && fk.fromColumns[0] === column) ??
    table.foreignKeys.find((fk) => fk.fromColumns.length > 1 && fk.fromColumns[0] === column)
  );
}

/** Columns written by a multi-column selector led by another column (no control of their own). */
function coveredColumns(table: TableSchema): Set<string> {
  const covered = new Set<string>();
  for (const fk of table.foreignKeys)
    if (fk.fromColumns.length > 1 && keyFor(table, fk.fromColumns[0]) === fk)
      for (const column of fk.fromColumns.slice(1)) if (!keyFor(table, column)) covered.add(column);
  return covered;
}

function columnControl(
  table: TableSchema,
  column: DbColumn,
  form: DesignForm,
  options: GenerateOptions,
): DesignControl | null {
  const foreignKey = keyFor(table, column.name);
  const kind: ControlKind | null = foreignKey ? "relationship" : kindForColumn(column);
  if (!kind) return null;
  const auto = isAutoKey(table, column);
  const composite = foreignKey && foreignKey.fromColumns.length > 1;
  const label = composite
    ? foreignKey.targetTable.replace(/s$/i, "")
    : foreignKey
      ? column.name.replace(/_?id$/i, "") || column.name
      : column.name;
  const control: DesignControl = {
    id: newId(),
    kind,
    label: humanize(label),
    binding: { column: column.name },
    validation: { required: !column.nullable && !auto && column.defaultValue == null },
    placement: nextPlacement(form, null, { columnSpan: kind === "multiline" ? 12 : 6 }),
  };
  if (auto) control.readOnly = true;
  if (foreignKey) {
    const valueColumn = foreignKey.targetColumns[0] ?? "id";
    control.relationship = {
      table: foreignKey.targetTable,
      valueColumn,
      displayColumn: displayColumnFor(options.targets?.[foreignKey.targetTable], valueColumn),
    };
    if (composite)
      control.relationship.keys = foreignKey.fromColumns.map((from, i) => ({
        column: from,
        target: foreignKey.targetColumns[i] ?? from,
      }));
  }
  return control;
}

function relatedListControl(
  table: TableSchema,
  child: TableSchema,
  detail: DesignForm,
  options: GenerateOptions,
): DesignControl | null {
  const link = child.foreignKeys.find((fk) => fk.targetTable === table.name);
  if (!link) return null;
  const primaryKey = table.columns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((a, b) => a.primaryKeyPosition - b.primaryKeyPosition)
    .map((column) => column.name);
  const keys = link.fromColumns.map((column, i) => ({
    column,
    target: link.targetColumns[i] ?? primaryKey[i] ?? "id",
  }));
  const related: NonNullable<DesignControl["related"]> = {
    table: child.name,
    foreignKey: keys[0].column,
    parentColumn: keys[0].target,
    columns: child.columns
      .filter((column) => !link.fromColumns.includes(column.name) && kindForColumn(column))
      .map((column) => column.name),
    formId: options.childForms?.[child.name] ?? null,
  };
  if (keys.length > 1) related.keys = keys;
  return {
    id: newId(),
    kind: "relatedList",
    label: humanize(child.name),
    validation: { required: false },
    placement: nextPlacement(detail, null),
    related,
  };
}

/**
 * Generated CRUD (PRD §14): a list form and a detail/create/edit form for one table,
 * built only from the public form primitives a designer uses by hand.
 */
export function generateCrudForms(
  table: TableSchema,
  options: GenerateOptions = {},
): GeneratedCrud {
  const title = humanize(table.name);
  const source = { kind: "table" as const, table: table.name };
  const detail: DesignForm = { ...newForm(title, source), modes: ["detail", "create", "edit"] };
  const covered = coveredColumns(table);
  for (const column of table.columns) {
    if (covered.has(column.name)) continue;
    const control = columnControl(table, column, detail, options);
    if (control) detail.controls.push(control);
  }
  for (const child of options.children ?? []) {
    const control = relatedListControl(table, child, detail, options);
    if (control) detail.controls.push(control);
  }
  const list: DesignForm = {
    ...newForm(`${title} list`, source),
    modes: ["list"],
    layout: defaultGridLayout(),
    listColumns: table.columns.filter((column) => kindForColumn(column)).map((c) => c.name),
    detailFormId: detail.id,
  };
  return {
    list,
    detail,
    navigation: { id: newId(), label: title, kind: "form", targetId: list.id, children: [] },
  };
}
