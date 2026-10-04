/**
 * Shared App QA helpers: render the production app, seed data through the
 * real Rust bridge, and reach modes and settings tabs the way a user does.
 */
import { join } from "node:path";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import App from "../../../src/App";
import { dialogMock, stateDirectory } from "../../../tests/setup.screenshot";

export const LONG = { timeout: 20_000 };
export type User = ReturnType<typeof userEvent.setup>;
export type DataValue = { type: string; value?: string | number | boolean };
export { dialogMock };

/** A path in the per-run state directory, for Save As and export dialogs. */
export const tempPath = (name: string) => join(stateDirectory, name);

export async function renderNewDocument(): Promise<User> {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /New document/ }, LONG));
  await screen.findByText("Relationship Browser", {}, LONG);
  return user;
}

/** Creates a document from a golden template through the start screen. */
export async function startFromTemplate(name: string): Promise<User> {
  const user = userEvent.setup();
  render(<App />);
  const section = await screen.findByRole("region", { name: "Start from a template" }, LONG);
  await user.click(
    await within(section).findByRole("button", { name: `Create ${name} from template` }, LONG),
  );
  await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
  return user;
}

type Column = {
  name: string;
  declaredType: string;
  nullable?: boolean;
  primaryKeyPosition?: number;
};
type ForeignKey = { columns: string[]; targetTable: string; targetColumns: string[] };

export async function createTable(name: string, columns: Column[], foreignKeys: ForeignKey[] = []) {
  await invoke("create_database_table", {
    windowLabel: "main",
    spec: {
      name,
      columns: columns.map((column) => ({
        nullable: !column.primaryKeyPosition,
        primaryKeyPosition: 0,
        unique: false,
        defaultExpression: null,
        generatedExpression: null,
        ...column,
      })),
      foreignKeys: foreignKeys.map((fk) => ({ ...fk, onUpdate: null, onDelete: null })),
      checks: [],
      withoutRowid: false,
    },
  });
}

const toValue = (raw: string | number | null): DataValue =>
  raw === null
    ? { type: "null" }
    : typeof raw === "number"
      ? { type: Number.isInteger(raw) ? "integer" : "real", value: raw }
      : { type: "text", value: raw };

export async function insert(table: string, record: Record<string, string | number | null>) {
  await invoke("insert_row", {
    windowLabel: "main",
    table,
    values: Object.entries(record).map(([column, raw]) => ({ column, value: toValue(raw) })),
  });
}

export async function refreshDatabase() {
  await act(async () => {
    window.dispatchEvent(new Event("ixtable:database-changed"));
  });
}

/**
 * A small order-entry schema: customers ← orders ← order_items, with readable
 * sample rows so forms, queries, and runtime lists have realistic content.
 */
export async function seedSales() {
  await createTable("customers", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT", nullable: false },
    { name: "city", declaredType: "TEXT" },
  ]);
  await createTable(
    "orders",
    [
      { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
      { name: "customer_id", declaredType: "INTEGER", nullable: false },
      { name: "status", declaredType: "TEXT" },
      { name: "amount", declaredType: "REAL" },
      { name: "note", declaredType: "TEXT" },
    ],
    [{ columns: ["customer_id"], targetTable: "customers", targetColumns: ["id"] }],
  );
  await createTable(
    "order_items",
    [
      { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
      { name: "order_id", declaredType: "INTEGER" },
      { name: "product", declaredType: "TEXT" },
      { name: "quantity", declaredType: "INTEGER" },
    ],
    [{ columns: ["order_id"], targetTable: "orders", targetColumns: ["id"] }],
  );
  const customers = [
    [1, "Northstar Goods", "Leeds"],
    [2, "Juniper Supply", "Bristol"],
    [3, "Harbor & Pine", "York"],
  ] as const;
  for (const [id, name, city] of customers) await insert("customers", { id, name, city });
  const orders = [
    [1, 1, "open", 120, "Gift wrap"],
    [2, 1, "shipped", 340, null],
    [3, 2, "open", 75.5, null],
    [4, 3, "shipped", 410, "Fragile"],
    [5, 2, "cancelled", 20, null],
  ] as const;
  for (const [id, customer_id, status, amount, note] of orders)
    await insert("orders", { id, customer_id, status, amount, note });
  const items = [
    [1, 1, "Ceramic pour-over set", 2],
    [2, 1, "Oak serving board", 1],
    [3, 2, "Linen napkins", 6],
  ] as const;
  for (const [id, order_id, product, quantity] of items)
    await insert("order_items", { id, order_id, product, quantity });
  await refreshDatabase();
  await screen.findByRole("button", { name: /^order_items\b/ }, LONG);
}

/** Saves the open document to a new archive through the Save As dialog. */
export async function saveAs(user: User, name: string) {
  const path = tempPath(name);
  dialogMock.save.mockResolvedValueOnce(path);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, LONG);
  return path;
}

/** Saves, closes, and reopens: some editors load saved queries on open. */
export async function saveAndReopen(user: User, name: string) {
  const path = await saveAs(user, name);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  dialogMock.open.mockResolvedValueOnce(path);
  await user.click(await screen.findByRole("button", { name: /Open document/ }, LONG));
  await screen.findByText("Saved archive", {}, LONG);
  return path;
}

export async function openMode(user: User, mode: string) {
  await user.click(screen.getByRole("button", { name: mode }));
}

export async function openSettingsTab(user: User, tab: string) {
  await openMode(user, "Settings");
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: tab }));
}

export async function saveQuery(name: string, sql: string, parameters: unknown[] = []) {
  const config = await invoke<Record<string, unknown> & { savedQueries: unknown[] }>(
    "read_document_config",
    { windowLabel: "main" },
  );
  await invoke("update_document_config", {
    windowLabel: "main",
    config: {
      ...config,
      savedQueries: [
        ...config.savedQueries,
        { id: crypto.randomUUID(), name, sql, parameters, builder: null },
      ],
    },
  });
}
