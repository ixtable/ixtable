import type { ActionDef, Trigger } from "../automation/types";
import type { Dashboard } from "../dashboards/types";
import type { DesignSchema } from "../design/schema";
import type { Migration } from "../migrations/types";
import type { SavedQuery } from "../query/types";
import type { CloudLink } from "../cloud/types";
import type { Report } from "../reports/types";
import type { Role } from "../runtime/types";
import type { DatasourceConfig, EntitySettings } from "../schema/types";

export interface SessionState {
  sessionId: string;
  documentId: string;
  name: string;
  path?: string | null;
  workspace: string;
  dirty: boolean;
  conflict: boolean;
  saving: boolean;
  activeMode: string;
  attachmentCount: number;
  autosaveEligible: boolean;
  // RFC 3339 time of the last successful save in this session.
  lastSavedAt?: string | null;
  // Failure of the most recent save or autosave; cleared by the next successful save.
  lastError?: { code: string; message: string } | null;
  /** Opened from a runtime-only bundle: only Runtime mode, definition read-only. */
  runtimeOnly?: boolean;
  bundleVersion?: string | null;
  /** Bumped by every backend config mutation; the config store reloads when it is ahead. */
  configRevision?: number;
}

export interface ReleaseInfo {
  version: string;
  notes: string;
  minRuntimeVersion?: string | null;
}

export interface DocumentConfig {
  version: number;
  name: string;
  activeMode: string;
  navigationState: unknown;
  settings: unknown;
  savedQueries: SavedQuery[];
  design: DesignSchema;
  reports: Report[];
  dashboards: Dashboard[];
  actions: ActionDef[];
  triggers: Trigger[];
  migrations: Migration[];
  datasource: DatasourceConfig;
  entities: EntitySettings[];
  roles: Role[];
  release: ReleaseInfo;
  /** The ixtable Cloud application this document publishes to. */
  cloud?: CloudLink | null;
}

export interface Issue {
  severity: "error" | "warning";
  objectKind: string;
  objectId: string;
  message: string;
}

export interface RecentFile {
  path: string;
  openedAt: string;
}

export type DataValue = {
  type:
    | "null"
    | "integer"
    | "real"
    | "text"
    | "blob"
    | "boolean"
    | "date"
    | "timestamp"
    | "decimal"
    | "time";
  value?: string | number | boolean;
};
export type NamedValue = { column: string; value: DataValue };
export type DbObject = { name: string; objectType: string; rowCount: number | null };
export type DbColumn = {
  name: string;
  declaredType: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKeyPosition: number;
  generated: boolean;
  /** Logical type (`text`, `integer`, `decimal(10,2)`, …); see src/schema/logical.ts. */
  logicalType?: string;
  unique?: boolean;
  /** The database fills it in on insert (SQLite rowid alias, PostgreSQL identity or serial). */
  autoIncrement?: boolean;
};
export type DbForeignKey = {
  id: number;
  name?: string | null;
  fromColumns: string[];
  targetTable: string;
  targetColumns: string[];
  onUpdate: string;
  onDelete: string;
};
export type TableSchema = {
  name: string;
  columns: DbColumn[];
  foreignKeys: DbForeignKey[];
  withoutRowid: boolean;
  objectType?: string;
  primaryKey?: string[];
  uniques?: Array<{ name?: string | null; columns: string[] }>;
  checks?: Array<{ name?: string | null; expression: string }>;
  indexes?: Array<{
    name: string;
    table: string;
    columns: string[];
    unique: boolean;
    sql?: string | null;
  }>;
};
export type DbPage = {
  columns: DbColumn[];
  rows: DataValue[][];
  identities: DataValue[][];
  total: number;
  offset: number;
  limit: number;
};
export type QueryResult = { columns: string[]; rows: DataValue[][] };
export type Sort = { column: string; descending: boolean };
export type FilterOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "starts_with"
  | "is_null"
  | "is_not_null"
  | "in";
/** `in` matches any of `values`. */
export type Filter = {
  column: string;
  operator: FilterOperator;
  value?: DataValue | null;
  values?: DataValue[];
};
export type CreateColumnSpec = {
  name: string;
  /** Legacy SQLite affinity; `logicalType` wins when both are set. */
  declaredType: string;
  logicalType?: string | null;
  nullable: boolean;
  primaryKeyPosition: number;
  unique: boolean;
  defaultExpression: string | null;
  generatedExpression: string | null;
  check?: string | null;
};
export type CreateForeignKeySpec = {
  name?: string | null;
  columns: string[];
  targetTable: string;
  targetColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
};
export type CreateTableSpec = {
  name: string;
  columns: CreateColumnSpec[];
  foreignKeys: CreateForeignKeySpec[];
  checks: string[];
  withoutRowid: boolean;
  /** Multi-column unique constraints. */
  uniques?: string[][];
  indexes?: Array<{ name: string; columns: string[]; unique: boolean }>;
};
export type AlterTableOperation =
  | { operation: "rename_table"; newName: string }
  | { operation: "rename_column"; column: string; newName: string }
  | { operation: "add_column"; column: CreateColumnSpec }
  | { operation: "drop_column"; column: string }
  | { operation: "alter_column"; column: string; definition: CreateColumnSpec }
  | { operation: "set_primary_key"; columns: string[] }
  | { operation: "add_foreign_key"; foreignKey: CreateForeignKeySpec }
  | { operation: "drop_foreign_key"; columns: string[] }
  | { operation: "add_unique"; columns: string[]; name?: string | null }
  | { operation: "drop_unique"; columns: string[] }
  | { operation: "add_check"; expression: string; name?: string | null }
  | { operation: "drop_check"; expression: string };
