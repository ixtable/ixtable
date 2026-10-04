import { defaultGridLayout } from "../grid/engine";
import type { DbColumn, TableSchema } from "../lib/types";
import { newId } from "../lib/utils";
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

/** Control kind for a column's declared SQL type (SQLite affinity rules, plus date names). */
export function kindForColumn(column: Pick<DbColumn, "declaredType">): ControlKind | null {
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

/** True for an `INTEGER PRIMARY KEY` that SQLite fills in on insert. */
export const isAutoKey = (table: TableSchema, column: DbColumn) =>
  column.primaryKeyPosition > 0 &&
  column.declaredType.toUpperCase() === "INTEGER" &&
  table.columns.filter((c) => c.primaryKeyPosition > 0).length === 1;

export type GenerateOptions = {
  /** Schemas of tables referenced by foreign keys, used to pick lookup display columns. */
  targets?: Record<string, TableSchema>;
  /** Tables whose foreign keys point at this table; each becomes a related-record list. */
  children?: TableSchema[];
};

export type GeneratedCrud = { list: DesignForm; detail: DesignForm; navigation: NavigationItem };

function columnControl(
  table: TableSchema,
  column: DbColumn,
  form: DesignForm,
  options: GenerateOptions,
): DesignControl | null {
  const foreignKey = table.foreignKeys.find(
    (key) => key.fromColumns.length === 1 && key.fromColumns[0] === column.name,
  );
  const kind: ControlKind | null = foreignKey ? "relationship" : kindForColumn(column);
  if (!kind) return null;
  const auto = isAutoKey(table, column);
  const control: DesignControl = {
    id: newId(),
    kind,
    label: humanize(foreignKey ? column.name.replace(/_?id$/i, "") || column.name : column.name),
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
  }
  return control;
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
  for (const column of table.columns) {
    const control = columnControl(table, column, detail, options);
    if (control) detail.controls.push(control);
  }
  const key = table.columns.find((column) => column.primaryKeyPosition > 0)?.name;
  for (const child of options.children ?? []) {
    const link = child.foreignKeys.find(
      (fk) => fk.targetTable === table.name && fk.fromColumns.length === 1,
    );
    if (!link) continue;
    detail.controls.push({
      id: newId(),
      kind: "relatedList",
      label: humanize(child.name),
      validation: { required: false },
      placement: nextPlacement(detail, null),
      related: {
        table: child.name,
        foreignKey: link.fromColumns[0],
        parentColumn: link.targetColumns[0] ?? key ?? "id",
        columns: child.columns
          .filter((column) => column.name !== link.fromColumns[0] && kindForColumn(column))
          .map((column) => column.name),
        formId: null,
      },
    });
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
