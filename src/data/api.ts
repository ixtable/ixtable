import { call } from "../lib/api";
import type { AlterTableOperation, CreateTableSpec, SessionState } from "../lib/types";

export const createDatabaseTable = (spec: CreateTableSpec) =>
  call<SessionState>("create_database_table", { spec });
export const alterDatabaseTable = (table: string, operation: AlterTableOperation) =>
  call<SessionState>("alter_database_table", { table, operation });
