import { invoke } from "@tauri-apps/api/core";
import type {
  DbObject,
  DbPage,
  DocumentConfig,
  Filter,
  Issue,
  QueryResult,
  RecentFile,
  SessionState,
  Sort,
  TableSchema,
} from "./types";

export const WINDOW_LABEL = "main";

export interface TauriError {
  code: string;
  message: string;
}

/** Error thrown by `call`; carries the backend `AppError` code. */
export class CommandError extends Error implements TauriError {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export const asTauriError = (error: unknown): TauriError => {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const structured = error as TauriError;
    const nested = structured.message.match(/^([A-Z][A-Z_]+):\s*(.*)/);
    return nested ? { code: nested[1], message: nested[2] } : structured;
  }
  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error) as TauriError;
      if (parsed.code && parsed.message) return parsed;
    } catch {
      // fall through to the bridge message
    }
    const match = error.match(/([A-Z][A-Z_]+):\s*(.*)/);
    if (match) return { code: match[1], message: match[2] };
  }
  return { code: "TAURI_ERROR", message: error instanceof Error ? error.message : String(error) };
};

/** The single Tauri entry point: injects `windowLabel` and throws `CommandError`. */
export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(command, { windowLabel: WINDOW_LABEL, ...args });
  } catch (error) {
    const { code, message } = asTauriError(error);
    throw new CommandError(code, message);
  }
}

export const appInfo = () => call<{ name: string; runtime: string }>("app_info");
export const newDocument = () => call<SessionState>("new_document");
export const openDocument = (path: string) => call<SessionState>("open_document", { path });
export const saveDocument = () => call<SessionState>("save_document");
export const saveDocumentAs = (path: string) => call<SessionState>("save_document_as", { path });
export const closeDocument = (force: boolean) => call<void>("close_document", { force });
export const listRecentFiles = () => call<RecentFile[]>("list_recent_files");
/** Files the app was launched with (an OS file association); returned once per process. */
export const takeLaunchFiles = () => call<string[]>("take_launch_files");

export const readDocumentConfig = () => call<DocumentConfig>("read_document_config");
export const updateDocumentConfig = (config: DocumentConfig) =>
  call<SessionState>("update_document_config", { config });
export const readDocumentConfigYaml = () => call<string>("read_document_config_yaml");
export const applyDocumentConfigYaml = (yaml: string) =>
  call<SessionState>("apply_document_config_yaml", { yaml });
export const validateDocument = () => call<Issue[]>("validate_document");

export const listDatabaseObjects = () => call<DbObject[]>("list_database_objects");
export const inspectTable = (table: string) => call<TableSchema>("inspect_table", { table });
export const readTablePage = (
  table: string,
  options: { offset?: number; limit?: number; sorts?: Sort[]; filters?: Filter[] } = {},
) =>
  call<DbPage>("read_table_page", {
    table,
    offset: options.offset ?? 0,
    limit: options.limit ?? 100,
    sorts: options.sorts ?? [],
    filters: options.filters ?? [],
  });
export const executeReadQuery = (sql: string) => call<QueryResult>("execute_read_query", { sql });
