import { fromDataValue } from "../automation/values";
import type { DataValue, DbColumn, NamedValue } from "../lib/types";

export { fromDataValue };

export type RecordValues = Record<string, unknown>;

export const rowObject = (columns: { name: string }[], row: DataValue[]): RecordValues =>
  Object.fromEntries(columns.map((column, i) => [column.name, fromDataValue(row[i])]));

const isBlank = (value: unknown) =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "");

/** Converts a form value into a typed DataValue using the column's declared type. */
export function toColumnValue(value: unknown, declaredType = ""): DataValue {
  if (isBlank(value)) return { type: "null" };
  const type = declaredType.toUpperCase();
  if (type.includes("BOOL"))
    return { type: "boolean", value: value === true || value === "true" || value === 1 };
  if (type.includes("INT") || /REAL|FLOA|DOUB|NUM|DEC|MONEY/.test(type)) {
    const number = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
    if (!Number.isFinite(number)) return { type: "text", value: String(value) };
    return type.includes("INT") && Number.isInteger(number)
      ? { type: "integer", value: number }
      : { type: "real", value: number };
  }
  if (typeof value === "boolean") return { type: "integer", value: value ? 1 : 0 };
  if (typeof value === "number")
    return Number.isInteger(value) ? { type: "integer", value } : { type: "real", value };
  if (type.includes("TIMESTAMP") || type.includes("DATETIME"))
    return { type: "timestamp", value: String(value) };
  if (type.includes("DATE")) return { type: "date", value: String(value) };
  return { type: "text", value: String(value) };
}

/** Named values for the given record fields, typed by the table columns. */
export function namedValues(
  values: RecordValues,
  columns: Pick<DbColumn, "name" | "declaredType">[],
  only?: string[],
): NamedValue[] {
  return columns
    .filter((column) => column.name in values && (!only || only.includes(column.name)))
    .map((column) => ({
      column: column.name,
      value: toColumnValue(values[column.name], column.declaredType),
    }));
}

/** Display text for a value (dates stay ISO, booleans as Yes/No). */
export function displayText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Loose equality for record values coming from different sources (1 vs "1"). */
export const sameValue = (a: unknown, b: unknown) =>
  a === b || (a != null && b != null && String(a) === String(b));
