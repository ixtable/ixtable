import type { DataValue, SessionState } from "../lib/types";

export type FileFormat = "csv" | "xlsx" | "json" | "parquet";

export interface ParseOptions {
  format?: FileFormat | null;
  // The first CSV or XLSX row holds column names.
  header: boolean;
  // CSV delimiter; detected when empty.
  delimiter?: string | null;
  // XLSX worksheet; the first one when empty.
  sheet?: string | null;
}

export interface SourceColumn {
  name: string;
  logicalType: string;
}

export interface FilePreview {
  format: FileFormat;
  columns: SourceColumn[];
  rows: DataValue[][];
  totalRows: number;
  sheets: string[];
}

export interface NewColumn {
  source: string;
  name: string;
  logicalType: string;
}

export interface FieldMapping {
  source: string;
  field: string;
}

export type ImportTarget =
  | { kind: "newTable"; table: string; columns: NewColumn[]; primaryKey?: string | null }
  | { kind: "existingTable"; table: string; mapping: FieldMapping[] };

export interface RowError {
  row: number;
  column: string | null;
  message: string;
}

export interface ImportReport {
  table: string;
  totalRows: number;
  imported: number;
  failed: number;
  errors: RowError[];
  // Why the import stopped early; rows written before it stay.
  aborted: string | null;
  state: SessionState | null;
}

/** A bundled read-only file the reader exposes as `files.<name>`. */
export interface FileSource {
  id: string;
  name: string;
  assetId: string;
  format: FileFormat;
  csv?: { header: boolean; delimiter?: string | null };
}

export interface FileSourceInfo {
  id: string;
  name: string;
  columns: SourceColumn[];
  rowCount: number | null;
  error: string | null;
}
