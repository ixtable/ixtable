import type { DataValue, DbColumn, NamedValue } from "../lib/types";

/** Converts a JS value from the expression language into a RecordStore DataValue. */
export function toDataValue(value: unknown): DataValue {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { type: "null" };
    return Number.isInteger(value) ? { type: "integer", value } : { type: "real", value };
  }
  if (typeof value === "bigint") return { type: "integer", value: Number(value) };
  if (typeof value === "string") return { type: "text", value };
  return { type: "text", value: JSON.stringify(value) };
}

/** Converts a RecordStore DataValue into a plain JS value for expression scopes. */
export function fromDataValue(value: DataValue | null | undefined): unknown {
  if (!value || value.type === "null") return null;
  if (value.type === "integer" || value.type === "real") return Number(value.value);
  return value.value ?? null;
}

export const toNamedValues = (values: Record<string, unknown>): NamedValue[] =>
  Object.entries(values).map(([column, value]) => ({ column, value: toDataValue(value) }));

export const namedToObject = (values: NamedValue[]): Record<string, unknown> =>
  Object.fromEntries(values.map((v) => [v.column, fromDataValue(v.value)]));

export const rowToObject = (
  columns: (DbColumn | string)[],
  row: DataValue[],
): Record<string, unknown> =>
  Object.fromEntries(
    columns.map((c, i) => [typeof c === "string" ? c : c.name, fromDataValue(row[i])]),
  );

/** Stable FNV-1a hash (hex) of a JSON value with sorted object keys. */
export function stableHash(value: unknown): string {
  const text = stableJson(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
