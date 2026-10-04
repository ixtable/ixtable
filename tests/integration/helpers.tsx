import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import App from "../../src/App";

export type DataValue = {
  type: "null" | "integer" | "real" | "text" | "blob" | "boolean" | "date" | "timestamp";
  value?: string | number | boolean;
};
export const value = (type: DataValue["type"], raw?: DataValue["value"]): DataValue =>
  raw === undefined ? { type } : { type, value: raw };

export async function renderNewDocument() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: /New document/i }));
  await screen.findByText("Relationship Browser", {}, { timeout: 20_000 });
  return user;
}

export async function createTable(
  name: string,
  columns: Array<{
    name: string;
    declaredType: string;
    nullable?: boolean;
    primaryKeyPosition?: number;
    defaultExpression?: string | null;
  }>,
) {
  await invoke("create_database_table", {
    windowLabel: "main",
    spec: {
      name,
      columns: columns.map((column) => ({
        nullable: true,
        primaryKeyPosition: 0,
        unique: false,
        defaultExpression: null,
        generatedExpression: null,
        ...column,
      })),
      foreignKeys: [],
      checks: [],
      withoutRowid: false,
    },
  });
  window.dispatchEvent(new Event("ixtable:database-changed"));
  await screen.findAllByText(name, {}, { timeout: 20_000 });
  const button = await screen.findByRole("button", { name: new RegExp(`^${name}\\b`) });
  button.click();
}

export async function insertRow(
  table: string,
  values: Array<{ column: string; value: DataValue }>,
) {
  await invoke("insert_row", { windowLabel: "main", table, values });
}

export async function readPage(table: string, sorts: unknown[] = [], filters: unknown[] = []) {
  return invoke<{
    columns: Array<{ name: string }>;
    rows: DataValue[][];
    identities: DataValue[][];
    total: number;
  }>("read_table_page", { windowLabel: "main", table, offset: 0, limit: 100, sorts, filters });
}

/** Dispatches a database-changed event and waits until the metadata reload it starts finishes. */
export function announceDatabaseChange() {
  act(() => {
    window.dispatchEvent(new Event("ixtable:database-changed"));
  });
}

export async function refreshDatabase() {
  const idle = () =>
    waitFor(
      () => {
        const objects = screen.queryByRole("region", { name: "Database objects" });
        expect(objects && within(objects).queryByRole("status")).toBeNull();
        expect(screen.queryByText("Refreshing schema…")).toBeNull();
      },
      { timeout: 20_000 },
    );
  await idle();
  announceDatabaseChange();
  await idle();
}

export function grid() {
  return screen.getByRole("table");
}
export function row(number: number) {
  return within(grid()).getByRole("textbox", { name: new RegExp(`row ${number}$`) });
}
