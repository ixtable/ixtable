import type { TableSchema } from "../lib/types";
import type { FilePreview, ImportTarget, ParseOptions } from "./types";

/** A new-table column draft: `include` false leaves the source column out. */
export interface ColumnDraft {
  source: string;
  name: string;
  logicalType: string;
  include: boolean;
}

/** Source column name → target field name ("" skips the column). */
export type FieldDrafts = Record<string, string>;

/** An identifier safe to use unquoted: lower-case letters, digits, and `_`. */
export function identifier(raw: string, fallback = "imported"): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return fallback;
  return /^[a-z_]/.test(cleaned) ? cleaned.slice(0, 63) : `_${cleaned}`.slice(0, 63);
}

/** The file's base name without its extension, as an identifier. */
export function nameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  return identifier(base.replace(/\.[^.]+$/, ""));
}

export const defaultOptions = (): ParseOptions => ({ header: true, delimiter: "", sheet: "" });

/** Options as sent to Rust: empty delimiter and sheet mean "detect" and "first". */
export const cleanOptions = (options: ParseOptions): ParseOptions => ({
  header: options.header,
  delimiter: options.delimiter || null,
  sheet: options.sheet || null,
});

export function defaultColumns(preview: FilePreview): ColumnDraft[] {
  const used = new Set<string>();
  return preview.columns.map((column, i) => {
    const base = identifier(column.name, `column_${i + 1}`);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    return { source: column.name, name, logicalType: column.logicalType, include: true };
  });
}

/** The draft named `id`, which becomes the key instead of a generated one. */
export const defaultPrimaryKey = (columns: ColumnDraft[]) =>
  columns.find((c) => c.include && c.name === "id")?.name ?? "";

/** Maps each source column to the field with the same name (ignoring case and punctuation). */
export function defaultMapping(preview: FilePreview, table: TableSchema | undefined): FieldDrafts {
  const fields = (table?.columns ?? []).filter((c) => !c.generated);
  return Object.fromEntries(
    preview.columns.map((column) => {
      const wanted = identifier(column.name, "");
      const field = fields.find((f) => identifier(f.name, "") === wanted);
      return [column.name, field?.name ?? ""];
    }),
  );
}

export function newTableTarget(
  table: string,
  columns: ColumnDraft[],
  primaryKey: string,
): ImportTarget {
  return {
    kind: "newTable",
    table,
    columns: columns
      .filter((c) => c.include)
      .map(({ source, name, logicalType }) => ({ source, name, logicalType })),
    primaryKey: primaryKey || null,
  };
}

export function existingTableTarget(table: string, mapping: FieldDrafts): ImportTarget {
  return {
    kind: "existingTable",
    table,
    mapping: Object.entries(mapping)
      .filter(([, field]) => field)
      .map(([source, field]) => ({ source, field })),
  };
}
