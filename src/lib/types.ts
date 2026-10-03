import type { ActionDef, Trigger } from "../automation/types";
import type { Dashboard } from "../dashboards/types";
import type { DesignSchema } from "../design/schema";
import type { Migration } from "../migrations/types";
import type { SavedQuery } from "../query/types";
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
  type: "null" | "integer" | "real" | "text" | "blob" | "boolean" | "date" | "timestamp";
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
};
export type DbForeignKey = {
  id: number;
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
  | "is_not_null";
export type Filter = { column: string; operator: FilterOperator; value?: DataValue | null };
export type CreateColumnSpec = {
  name: string;
  declaredType: string;
  nullable: boolean;
  primaryKeyPosition: number;
  unique: boolean;
  defaultExpression: string | null;
  generatedExpression: string | null;
};
export type CreateForeignKeySpec = {
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
};
export type AlterTableOperation =
  | { operation: "rename_table"; newName: string }
  | { operation: "rename_column"; column: string; newName: string }
  | { operation: "add_column"; column: CreateColumnSpec }
  | { operation: "drop_column"; column: string };
