// In-memory stand-in for the Rust record and job commands, used by automation unit tests.
import type { DataValue, Filter, NamedValue } from "../../src/lib/types";

type Row = Record<string, unknown>;
interface FakeTable {
  columns: { name: string; pk: number }[];
  rows: Row[];
  next: number;
  /** Throws on insert/update when it returns a message. */
  reject?: (row: Row) => string | undefined;
}

const toValue = (v: unknown): DataValue =>
  v === null || v === undefined
    ? { type: "null" }
    : typeof v === "number"
      ? { type: Number.isInteger(v) ? "integer" : "real", value: v }
      : typeof v === "boolean"
        ? { type: "boolean", value: v }
        : { type: "text", value: String(v) };
const fromValue = (v: DataValue) => (v.type === "null" ? null : v.value);

export function createFakeBackend() {
  const tables: Record<string, FakeTable> = {};
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const jobs: Record<string, unknown>[] = [];
  const keyOf = (t: FakeTable, row: Row) => t.columns.filter((c) => c.pk).map((c) => row[c.name]);
  const find = (t: FakeTable, identity: DataValue[]) =>
    t.rows.find((row) => keyOf(t, row).every((k, i) => k === fromValue(identity[i])));
  const table = (name: string) => {
    const t = tables[name];
    if (!t) throw new Error(`Table ${name} does not exist`);
    return t;
  };
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    inspect_table: ({ table: name }) => ({
      name,
      columns: table(name as string).columns.map((c) => ({
        name: c.name,
        declaredType: "",
        nullable: true,
        defaultValue: null,
        primaryKeyPosition: c.pk,
        generated: false,
      })),
      foreignKeys: [],
      withoutRowid: false,
    }),
    read_table_page: ({ table: name, filters }) => {
      const t = table(name as string);
      const rows = t.rows.filter((row) =>
        (filters as Filter[]).every((f) =>
          f.operator === "is_null"
            ? row[f.column] === null || row[f.column] === undefined
            : row[f.column] === fromValue(f.value as DataValue),
        ),
      );
      return {
        columns: t.columns.map((c) => ({ name: c.name })),
        rows: rows.map((row) => t.columns.map((c) => toValue(row[c.name]))),
        identities: rows.map((row) => keyOf(t, row).map(toValue)),
        total: rows.length,
        offset: 0,
        limit: 1000,
      };
    },
    insert_row: ({ table: name, values }) => {
      const t = table(name as string);
      const row: Row = Object.fromEntries(
        (values as NamedValue[]).map((v) => [v.column, fromValue(v.value)]),
      );
      if (row.id === undefined || row.id === null) row.id = t.next++;
      const problem = t.reject?.(row);
      if (problem) throw { code: "CONSTRAINT_VIOLATION", message: problem };
      t.rows.push(row);
      return keyOf(t, row).map(toValue);
    },
    update_row: ({ table: name, values, identity }) => {
      const t = table(name as string);
      const row = find(t, identity as DataValue[]);
      if (!row) throw { code: "STALE_ROW", message: "expected one row" };
      const next = { ...row };
      for (const v of values as NamedValue[]) next[v.column] = fromValue(v.value);
      const problem = t.reject?.(next);
      if (problem) throw { code: "CONSTRAINT_VIOLATION", message: problem };
      Object.assign(row, next);
      return 1;
    },
    delete_row: ({ table: name, identity }) => {
      const t = table(name as string);
      const row = find(t, identity as DataValue[]);
      if (!row) throw { code: "STALE_ROW", message: "expected one row" };
      t.rows.splice(t.rows.indexOf(row), 1);
      return 1;
    },
    execute_write_batch: ({ ops }) => {
      const snapshot = Object.fromEntries(
        Object.entries(tables).map(([name, t]) => [
          name,
          { rows: t.rows.map((r) => ({ ...r })), next: t.next },
        ]),
      );
      try {
        return (ops as Array<Record<string, unknown>>).map(({ op, ...args }) => {
          const result = handlers[`${op}_row`](args);
          return op === "insert" ? { changed: 1, identity: result } : { changed: result as number };
        });
      } catch (error) {
        for (const [name, saved] of Object.entries(snapshot)) Object.assign(tables[name], saved);
        throw error;
      }
    },
    enqueue_job: ({ job }) => {
      const request = job as Record<string, unknown>;
      const existing = jobs.find((j) => j.idempotencyKey === request.idempotencyKey);
      if (existing) return existing;
      const created = { id: `job${jobs.length + 1}`, status: "queued", ...request };
      jobs.push(created);
      return created;
    },
  };
  return {
    tables,
    calls,
    jobs,
    addTable(name: string, columns: string[], rows: Row[] = [], reject?: FakeTable["reject"]) {
      tables[name] = {
        columns: columns.map((c, i) => ({ name: c, pk: i === 0 ? 1 : 0 })),
        rows: rows.map((r) => ({ ...r })),
        next: rows.length + 1,
        reject,
      };
    },
    rows: (name: string) => tables[name].rows,
    on(command: string, handler: (args: Record<string, unknown>) => unknown) {
      handlers[command] = handler;
    },
    async invoke(command: string, args: Record<string, unknown> = {}) {
      calls.push({ command, args });
      const handler = handlers[command];
      if (!handler) throw { code: "NOT_FOUND", message: `No fake for ${command}` };
      return handler(args);
    },
  };
}
