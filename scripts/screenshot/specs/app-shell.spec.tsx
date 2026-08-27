import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { DocumentConfig, SessionState } from "../../../src/App";
import App from "../../../src/App";
import { captureDocument } from "../capture";

const column = (name: string, type = "TEXT", primaryKeyPosition = 0) => ({
  name,
  declaredType: type,
  nullable: primaryKeyPosition === 0,
  primaryKeyPosition,
  unique: false,
  defaultExpression: null,
  generatedExpression: null,
});
async function seedScreenshotDatabase() {
  const create = (
    name: string,
    columns: ReturnType<typeof column>[],
    foreignKeys: Array<Record<string, unknown>> = [],
  ) =>
    invoke("create_database_table", {
      windowLabel: "main",
      spec: { name, columns, foreignKeys, checks: [], withoutRowid: false },
    });
  await create("Customers", [
    column("Customer ID", "TEXT", 1),
    column("Company"),
    column("Contact Name"),
  ]);
  await create("Products", [
    column("Product ID", "TEXT", 1),
    column("Product Name"),
    column("Price", "REAL"),
  ]);
  await create(
    "Orders",
    [column("Order ID", "TEXT", 1), column("Customer ID"), column("Order Date")],
    [
      {
        columns: ["Customer ID"],
        targetTable: "Customers",
        targetColumns: ["Customer ID"],
        onUpdate: null,
        onDelete: null,
      },
    ],
  );
  await create(
    "Order Items",
    [
      column("Item ID", "INTEGER", 1),
      column("Order ID"),
      column("Product ID"),
      column("Quantity", "INTEGER"),
    ],
    [
      {
        columns: ["Order ID"],
        targetTable: "Orders",
        targetColumns: ["Order ID"],
        onUpdate: null,
        onDelete: null,
      },
      {
        columns: ["Product ID"],
        targetTable: "Products",
        targetColumns: ["Product ID"],
        onUpdate: null,
        onDelete: null,
      },
    ],
  );
  const insert = (table: string, record: Record<string, string | number>) =>
    invoke("insert_row", {
      windowLabel: "main",
      table,
      values: Object.entries(record).map(([column, value]) => ({
        column,
        value: {
          type: typeof value === "number" ? (Number.isInteger(value) ? "integer" : "real") : "text",
          value,
        },
      })),
    });
  await insert("Customers", {
    "Customer ID": "CUST-001",
    Company: "Northstar Goods",
    "Contact Name": "Avery Chen",
  });
  await insert("Customers", {
    "Customer ID": "CUST-002",
    Company: "Juniper Supply",
    "Contact Name": "Mina Patel",
  });
  await insert("Products", {
    "Product ID": "PROD-101",
    "Product Name": "Ceramic Pour-over Set",
    Price: 84,
  });
  await insert("Products", {
    "Product ID": "PROD-102",
    "Product Name": "Oak Serving Board",
    Price: 56,
  });
  await insert("Orders", {
    "Order ID": "10482",
    "Customer ID": "CUST-001",
    "Order Date": "14 Aug 2026",
  });
  await insert("Orders", {
    "Order ID": "10481",
    "Customer ID": "CUST-002",
    "Order Date": "13 Aug 2026",
  });
  await insert("Order Items", {
    "Item ID": 1,
    "Order ID": "10482",
    "Product ID": "PROD-101",
    Quantity: 2,
  });
  await insert("Order Items", {
    "Item ID": 2,
    "Order ID": "10481",
    "Product ID": "PROD-102",
    Quantity: 1,
  });
  await act(async () => {
    window.dispatchEvent(new Event("ixtable:database-changed"));
  });
}

it("captures the document lifecycle shell", async () => {
  const user = userEvent.setup();
  render(<App />);
  expect(await invoke("app_info", {})).toEqual({ name: "ixtable", runtime: "tauri" });
  await screen.findByRole("heading", { name: "Your data, in one portable file." });
  await captureDocument(document, {
    name: "app-qa-01-start",
    expectations: [
      "New and Open document actions are prominent.",
      "Recent documents has a clear empty state.",
    ],
  });
  await user.click(screen.getByRole("button", { name: /New document/ }));
  await screen.findByText("Relationship Browser", {}, { timeout: 10_000 });
  await seedScreenshotDatabase();
  await screen.findByText("4 tables · 3 relationships");
  const created = await invoke<SessionState>("document_state", { windowLabel: "main" });
  expect(created.name).toBe("Untitled");
  expect(created.activeMode).toBe("data");
  expect(screen.getByText(created.name)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
  expect(document.querySelectorAll(".react-flow__node")).toHaveLength(4);
  expect(screen.getByRole("region", { name: "Database objects" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Tables" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Views" })).not.toBeInTheDocument();
  expect(document.querySelector(".object-browser details")).not.toBeInTheDocument();
  expect(screen.getByText("Relationship Browser")).toBeInTheDocument();
  expect(document.querySelector(".workbench")).toHaveClass("relationship-only");
  expect(document.querySelector(".data-pane")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Search database objects" })).toBeInTheDocument();
  expect(screen.getByText("Workflow scripts are not available yet")).toBeInTheDocument();
  const attachmentDirectory = mkdtempSync(join(tmpdir(), "ixtable-app-qa-"));
  const attachmentPath = join(attachmentDirectory, "inventory-import-guide.pdf");
  writeFileSync(attachmentPath, "App QA attachment fixture");
  vi.mocked(open).mockResolvedValueOnce(attachmentPath);
  await user.click(screen.getByRole("button", { name: "Import attachment" }));
  expect(await screen.findByText("inventory-import-guide.pdf")).toBeInTheDocument();
  await captureDocument(document, {
    name: "app-qa-02-attachments",
    expectations: [
      "The project sidebar shows the attachment name, media type, size, and timestamp.",
      "Import, export, and removal controls remain accessible without obscuring database objects.",
      "The unsaved state and attachment count reflect the imported file.",
    ],
  });
  rmSync(attachmentDirectory, { recursive: true, force: true });
  await captureDocument(document, {
    name: "app-qa-02-object-browser",
    expectations: [
      "The sidebar shows compact, non-collapsible nested lists with tables and views combined under Tables.",
      "No table is selected and the grid asks the user to select one.",
      "The Relationship Browser fills the workbench while no object is selected.",
    ],
  });
  await user.click(screen.getByRole("button", { name: /^Customers\b/ }));
  await screen.findByRole("textbox", { name: "Customer ID, row 1" });
  expect(document.querySelector(".workbench")).not.toHaveClass("relationship-only");
  expect(document.querySelector(".data-pane")).toBeInTheDocument();
  await captureDocument(document, {
    name: "app-qa-03-data",
    expectations: [
      "The selected table is highlighted in the object browser and relationship canvas.",
      "The records grid shows rows loaded through backend commands.",
      "Document mode and save status remain visible.",
    ],
  });
  await captureDocument(document, {
    name: "app-qa-03-data-canvas",
    selector: ".flow-browser",
    viewport: { width: 1440, height: 900 },
    expectations: [
      "All four table nodes and their fields are fully visible.",
      "Three labelled relationships connect the related keys.",
    ],
  });
  const search = screen.getByRole("textbox", { name: "Search database objects" });
  await user.type(search, "Orders");
  expect(screen.queryByRole("button", { name: /^Customers\b/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Orders\b/ })).toBeInTheDocument();
  await user.clear(search);
  await user.click(screen.getByRole("button", { name: /^Orders\b/ }));
  const newOrder = await screen.findByRole("textbox", { name: "New Order ID" });
  await user.click(newOrder);
  await user.type(newOrder, "10483");
  await user.tab();
  await user.keyboard("CUST-001");
  expect(screen.getByRole("textbox", { name: "New Customer ID" })).toHaveValue("CUST-001");
  await captureDocument(document, {
    name: "app-qa-04-inline-record",
    expectations: [
      "A new record is entered directly in the final grid row.",
      "The active draft row remains aligned with the table columns.",
    ],
  });
  await user.keyboard("{Enter}");
  await waitFor(async () => {
    const inserted = await invoke<{ total: number; rows: unknown[][] }>("read_table_page", {
      windowLabel: "main",
      table: "Orders",
      offset: 0,
      limit: 100,
      sorts: [],
      filters: [],
    });
    expect(inserted.total).toBe(3);
    expect(inserted.rows).toHaveLength(3);
  });
  await user.click(screen.getByRole("button", { name: "New query" }));
  const sqlEditor = await screen.findByRole("textbox", { name: "SQL editor" });
  await user.clear(sqlEditor);
  await user.type(sqlEditor, "SELECT Company FROM Customers");
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(await screen.findByText("Northstar Goods")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Save query" }));
  expect(await screen.findByRole("button", { name: /^Untitled Query\b/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await captureDocument(document, {
    name: "app-qa-05-query",
    expectations: [
      "The SQL editor has query naming, Run, Save, and Delete actions.",
      "Typed query results appear below the editor.",
      "The saved query appears selected in the sidebar without replacing table metadata.",
    ],
  });
  await user.click(screen.getByRole("button", { name: "Design" }));
  await screen.findByRole("heading", { name: "Form builder" });
  const designConfig = await invoke<DocumentConfig>("read_document_config", {
    windowLabel: "main",
  });
  expect(designConfig.activeMode).toBe("design");
  expect(screen.getByRole("region", { name: "Product form builder" })).toBeInTheDocument();
  await captureDocument(document, {
    name: "app-qa-06-form-builder",
    expectations: [
      "Design mode shows the production form builder.",
      "The component library, form canvas, and properties panel are visible.",
    ],
  });
  await user.click(screen.getByRole("button", { name: "Preview app" }));
  expect(screen.getByRole("region", { name: "Published inventory app" })).toBeInTheDocument();
  await captureDocument(document, {
    name: "app-qa-07-app-preview",
    expectations: [
      "The built inventory app is shown in its usable runtime view.",
      "Metrics, search, filters, and product records are visible.",
    ],
  });
  await user.click(screen.getByRole("button", { name: "Save project" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("SAVE_AS_REQUIRED");
  await captureDocument(document, {
    name: "app-qa-08-save-error",
    expectations: [
      "The real backend error explains that an untitled project needs Save As.",
      "The project remains open with its unsaved state visible.",
    ],
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  await screen.findByRole("heading", { name: "Your data, in one portable file." });
  await expect(invoke("document_state", { windowLabel: "main" })).rejects.toBeTruthy();
  await captureDocument(document, {
    name: "app-qa-09-closed",
    expectations: ["Closing returns to the start screen.", "No desktop project remains visible."],
  });
});
