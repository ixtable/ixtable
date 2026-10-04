import type { DataValue, DbColumn } from "../lib/types";
import type { StoreCapabilities } from "./types";

/** Logical column types (PRD §11), in picker order. */
export const LOGICAL_TYPES = [
  { value: "text", label: "Text" },
  { value: "integer", label: "Integer" },
  { value: "real", label: "Number (floating point)" },
  { value: "decimal", label: "Decimal (precision, scale)" },
  { value: "boolean", label: "Yes / No" },
  { value: "date", label: "Date" },
  { value: "time", label: "Time" },
  { value: "timestamp", label: "Date and time" },
  { value: "uuid", label: "UUID" },
  { value: "json", label: "JSON" },
  { value: "blob", label: "Binary" },
] as const;

export interface LogicalParts {
  base: string;
  precision: number;
  scale: number;
}

export function parseLogical(type: string | null | undefined): LogicalParts {
  const match = (type ?? "text").trim().match(/^(\w+)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+))?\s*\))?$/);
  if (!match) return { base: "text", precision: 10, scale: 2 };
  return {
    base: match[1].toLowerCase(),
    precision: match[2] ? Number(match[2]) : 10,
    scale: match[3] ? Number(match[3]) : match[2] ? 0 : 2,
  };
}

export const formatLogical = ({ base, precision, scale }: LogicalParts) =>
  base === "decimal" ? `decimal(${precision},${scale})` : base;

/** The logical type of a column, falling back to SQLite affinity rules for older backends. */
export function logicalOf(column: Pick<DbColumn, "declaredType" | "logicalType">): string {
  if (column.logicalType) return column.logicalType;
  const t = column.declaredType.toUpperCase();
  if (t.includes("INT")) return "integer";
  if (/REAL|FLOA|DOUB/.test(t)) return "real";
  if (t.includes("BLOB")) return "blob";
  return "text";
}

/** Turns grid or form text into a typed value; throws a readable message when it does not fit. */
export function valueFromText(text: string, column: string, logicalType: string): DataValue {
  if (text === "NULL") return { type: "null" };
  const { base } = parseLogical(logicalType);
  switch (base) {
    case "integer": {
      if (!/^-?\d+$/.test(text.trim())) throw new Error(`${column} requires an integer`);
      const value = Number(text);
      if (!Number.isSafeInteger(value))
        throw new Error(`${column} is outside the safe integer range`);
      return { type: "integer", value };
    }
    case "real": {
      const value = Number(text);
      if (text.trim() === "" || !Number.isFinite(value))
        throw new Error(`${column} requires a number`);
      return { type: "real", value };
    }
    case "decimal":
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text.trim()))
        throw new Error(`${column} requires a decimal number`);
      return { type: "decimal", value: text.trim() };
    case "boolean": {
      const lower = text.trim().toLowerCase();
      if (["true", "yes", "1"].includes(lower)) return { type: "boolean", value: true };
      if (["false", "no", "0"].includes(lower)) return { type: "boolean", value: false };
      throw new Error(`${column} requires true or false`);
    }
    case "date":
      return { type: "date", value: text.trim() };
    case "time":
      return { type: "time", value: text.trim() };
    case "timestamp":
      return { type: "timestamp", value: text.trim() };
    default:
      return { type: "text", value: text };
  }
}

/** Store-neutral label for a change mode. */
export const modeLabel = (mode: string) =>
  mode === "inPlace"
    ? "Changes in place"
    : mode === "rebuild"
      ? "Requires table rebuild"
      : "Not supported by this store";

/** The store's display name, or null while capabilities are loading. */
export const storeLabel = (capabilities: StoreCapabilities | null) =>
  !capabilities
    ? null
    : capabilities.store === "postgres"
      ? "PostgreSQL"
      : capabilities.store === "sqlite"
        ? "SQLite"
        : capabilities.store;

/** Base names of the logical types the store maps (`decimal(p,s)` → `decimal`), or undefined while loading. */
export const storeTypes = (capabilities: StoreCapabilities | null) =>
  capabilities?.logicalTypes.map((t) => parseLogical(t.logicalType.replace("(p,s)", "")).base);
