import type { QueryResult } from "../lib/types";
import type { BuilderModel } from "./builder/model";

/** Parameter logical types accepted by `queries.rs` (`logical_type`). */
export const PARAMETER_TYPES = [
  "text",
  "integer",
  "number",
  "boolean",
  "date",
  "timestamp",
] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

export interface QueryParameter {
  // Placeholder name: `$name` in SQL.
  name: string;
  logicalType: ParameterType | string;
  defaultValue?: unknown;
  // A required parameter without a default must be supplied at run time.
  required?: boolean;
}

export interface SavedQuery {
  id: string;
  name: string;
  // Read-only SQL with `$name` placeholders. Compiled from `builder` when present.
  sql: string;
  filterState?: unknown;
  parameters?: QueryParameter[];
  // Visual builder model; absent for SQL-authored queries.
  builder?: BuilderModel | null;
}

/** `QueryResult` plus run metadata from `execute_parameterized_query` / `run_saved_query`. */
export interface QueryRunResult extends QueryResult {
  truncated: boolean;
  rowLimit: number;
  elapsedMs: number;
}
