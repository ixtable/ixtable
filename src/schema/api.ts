import { call } from "../lib/api";
import type { AlterTableOperation, SessionState } from "../lib/types";
import type {
  ChangePlan,
  ConnectionReport,
  DatasourceConfig,
  DatasourceStatus,
  StoreCapabilities,
  TableImpact,
} from "./types";

export const storeCapabilities = () => call<StoreCapabilities>("store_capabilities");

export const previewTableChanges = (table: string, operations: AlterTableOperation[]) =>
  call<ChangePlan>("preview_table_changes", { table, operations });
export const applyTableChanges = (table: string, operations: AlterTableOperation[]) =>
  call<SessionState>("apply_table_changes", { table, operations });

export const tableDropImpact = (table: string) => call<TableImpact>("table_drop_impact", { table });
export const dropDatabaseTable = (table: string) =>
  call<SessionState>("drop_database_table", { table });

export const createIndex = (spec: {
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
}) => call<SessionState>("create_index", { spec });
export const dropIndex = (name: string) => call<SessionState>("drop_index", { name });

export const testDatasourceConnection = (datasource: DatasourceConfig, password?: string) =>
  call<ConnectionReport>("test_datasource_connection", {
    datasource,
    password: password || null,
  });
/** Stores a password bound to `datasource`'s server, database, and user. */
export const setDatasourcePassword = (
  datasourceId: string,
  password: string,
  datasource: DatasourceConfig,
) => call<string>("set_datasource_password", { datasourceId, password, datasource });
export const clearDatasourcePassword = (passwordRef: string) =>
  call<void>("clear_datasource_password", { passwordRef });
export const connectDatasource = () => call<DatasourceStatus>("connect_datasource");
