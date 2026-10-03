import { call } from "../lib/api";
import type { CreateTableSpec, SessionState } from "../lib/types";

export const createDatabaseTable = (spec: CreateTableSpec) =>
  call<SessionState>("create_database_table", { spec });
