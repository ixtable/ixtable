import { call } from "./api";
import type { DataValue, NamedValue } from "./types";

export type RecordOperation = "insert" | "update" | "delete";

export interface RecordWrite {
  operation: RecordOperation;
  table: string;
  values: NamedValue[];
  identity: DataValue[] | null;
}

export interface RecordHook {
  // Runs before the write; throwing aborts it.
  before?: (write: RecordWrite) => void | Promise<void>;
  // Runs after the write commits, with the command result.
  after?: (write: RecordWrite, result: unknown) => void | Promise<void>;
}

const hooks = new Set<RecordHook>();

/** Registers a hook on every record write and returns its unregister function. */
export function registerRecordHook(hook: RecordHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

async function write<T>(record: RecordWrite, run: () => Promise<T>): Promise<T> {
  const active = [...hooks];
  for (const hook of active) await hook.before?.(record);
  const result = await run();
  for (const hook of active) await hook.after?.(record, result);
  return result;
}

/** Inserts a row and resolves with the new row's identity values. */
export const insertRecord = (table: string, values: NamedValue[]) =>
  write({ operation: "insert", table, values, identity: null }, () =>
    call<DataValue[]>("insert_row", { table, values }),
  );

/** Updates one row by identity and resolves with the affected row count. */
export const updateRecord = (table: string, values: NamedValue[], identity: DataValue[]) =>
  write({ operation: "update", table, values, identity }, () =>
    call<number>("update_row", { table, values, identity }),
  );

/** Deletes one row by identity and resolves with the affected row count. */
export const deleteRecord = (table: string, identity: DataValue[]) =>
  write({ operation: "delete", table, values: [], identity }, () =>
    call<number>("delete_row", { table, identity }),
  );
