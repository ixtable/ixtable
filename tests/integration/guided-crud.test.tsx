import { screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createTable,
  insertRow,
  readPage,
  refreshDatabase,
  renderNewDocument,
  value,
} from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };

type Design = { forms: Array<{ name: string }>; navigation: Array<{ label: string }> };
const design = async () =>
  (await invoke<{ design: Design }>("read_document_config", { windowLabel: "main" })).design;

async function createTableInUi(
  user: UserEvent,
  name: string,
  relation?: { column: string; target: string },
) {
  await user.click(screen.getByRole("button", { name: "New table" }));
  const form = await screen.findByRole("form", { name: "Create table" }, LONG);
  await user.type(within(form).getByLabelText("Table name"), name);
  if (relation) {
    await user.click(within(form).getByRole("button", { name: "Add column" }));
    await user.type(within(form).getByRole("textbox", { name: "Column 3 name" }), relation.column);
    await user.selectOptions(
      within(form).getByRole("combobox", { name: "Column 3 type" }),
      "integer",
    );
    await user.click(
      within(form).getByRole("checkbox", { name: `Relationship columns: ${relation.column}` }),
    );
    await user.selectOptions(
      within(form).getByRole("combobox", { name: "Target table" }),
      relation.target,
    );
    await user.selectOptions(
      within(form).getByRole("combobox", { name: `Target column for ${relation.column}` }),
      "id",
    );
    await user.click(within(form).getByRole("button", { name: "Add relationship" }));
  }
  await user.click(within(form).getByRole("button", { name: "Create table" }));
  await screen.findByRole("button", { name: new RegExp(`^${name}\\b`) }, LONG);
}

it("builds a working relational CRUD app from two new tables", async () => {
  const user = await renderNewDocument();
  await createTableInUi(user, "customers");
  const offer = await screen.findByRole("region", { name: "Forms for customers" }, LONG);
  await user.click(within(offer).getByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("region", { name: "Forms for customers" })).toBeNull();

  await createTableInUi(user, "orders", { column: "customer_id", target: "customers" });
  const ordersOffer = await screen.findByRole("region", { name: "Forms for orders" }, LONG);
  await user.click(within(ordersOffer).getByRole("button", { name: "Create forms for orders" }));
  expect(await screen.findByText(/Forms for orders are ready/, {}, LONG)).toBeInTheDocument();
  expect((await design()).forms.map((f) => f.name)).toEqual(["Main form", "Orders list", "Orders"]);

  await user.click(screen.getByRole("button", { name: "Design" }));
  await user.click(await screen.findByRole("button", { name: "Generate app from tables" }, LONG));
  expect(await screen.findByText("Added 3 forms and pages.", {}, LONG)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Generate app from tables" }));
  expect(await screen.findByText("Every table already has forms.", {}, LONG)).toBeInTheDocument();
  const generated = await design();
  expect(generated.forms.map((f) => f.name)).toEqual([
    "Main form",
    "Orders list",
    "Orders",
    "Customers list",
    "Customers",
  ]);
  expect(generated.navigation.map((n) => n.label)).toEqual(["Main form", "Orders", "Customers"]);

  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const page = await screen.findByRole("region", { name: "Application page" }, LONG);
  const nav = screen.getByRole("navigation", { name: "Application navigation" });

  await user.click(within(nav).getByRole("button", { name: "Customers" }));
  await user.click(await within(page).findByRole("button", { name: "New customers" }, LONG));
  const newCustomer = await screen.findByRole("form", { name: "New Customers" }, LONG);
  await user.type(within(newCustomer).getByRole("textbox", { name: "Name" }), "Acme");
  await user.click(within(newCustomer).getByRole("button", { name: "Create" }));
  await screen.findByRole("form", { name: "Customers" }, LONG);
  await waitFor(async () => expect((await readPage("customers")).total).toBe(1), LONG);

  await user.click(within(nav).getByRole("button", { name: "Orders" }));
  await user.click(await within(page).findByRole("button", { name: "New orders" }, LONG));
  const newOrder = await screen.findByRole("form", { name: "New Orders" }, LONG);
  const customer = within(newOrder).getByRole("combobox", { name: "Customer" });
  await within(customer).findByRole("option", { name: "Acme" }, LONG);
  await user.selectOptions(customer, "Acme");
  await user.type(within(newOrder).getByRole("textbox", { name: "Name" }), "First order");
  await user.click(within(newOrder).getByRole("button", { name: "Create" }));
  await screen.findByRole("form", { name: "Orders" }, LONG);
  await waitFor(async () => {
    const orders = await readPage("orders");
    expect(orders.rows.map((row) => row.map((cell) => cell.value))).toEqual([
      [1, "First order", 1],
    ]);
  }, LONG);

  await user.click(within(nav).getByRole("button", { name: "Customers" }));
  await user.click(await within(page).findByRole("row", { name: "Open 1" }, LONG));
  const related = await within(page).findByRole("region", { name: "Orders" }, LONG);
  expect(await within(related).findByRole("cell", { name: "First order" }, LONG)).toBeVisible();
});

it("shows lookup labels and related lists on table navigation pages", async () => {
  const user = await renderNewDocument();
  await createTable("customers", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT" },
  ]);
  await invoke("create_database_table", {
    windowLabel: "main",
    spec: {
      name: "orders",
      columns: [
        { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1, nullable: false },
        { name: "customer_id", declaredType: "INTEGER", primaryKeyPosition: 0, nullable: true },
        { name: "note", declaredType: "TEXT", primaryKeyPosition: 0, nullable: true },
      ].map((c) => ({ unique: false, defaultExpression: null, generatedExpression: null, ...c })),
      foreignKeys: [
        {
          columns: ["customer_id"],
          targetTable: "customers",
          targetColumns: ["id"],
          onUpdate: null,
          onDelete: null,
        },
      ],
      checks: [],
      withoutRowid: false,
    },
  });
  await insertRow("customers", [
    { column: "id", value: value("integer", 7) },
    { column: "name", value: value("text", "Acme") },
  ]);
  await insertRow("orders", [
    { column: "id", value: value("integer", 1) },
    { column: "customer_id", value: value("integer", 7) },
    { column: "note", value: value("text", "Rush") },
  ]);
  await refreshDatabase();
  await screen.findByRole("button", { name: /^orders\b/ }, LONG);

  await user.click(screen.getByRole("button", { name: "Design" }));
  await user.click(await screen.findByRole("button", { name: "Navigation" }, LONG));
  const editor = await screen.findByRole("region", { name: "Navigation editor" }, LONG);
  await user.selectOptions(
    within(editor).getByRole("combobox", { name: "Main form kind" }),
    "table",
  );
  await user.selectOptions(
    within(editor).getByRole("combobox", { name: "Main form opens" }),
    "orders",
  );

  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const page = await screen.findByRole("region", { name: "Application page" }, LONG);
  const row = await within(page).findByRole("row", { name: "Open 1" }, LONG);
  expect(await within(row).findByRole("cell", { name: "Acme" }, LONG)).toBeVisible();
  await user.click(row);
  const detail = await within(page).findByRole("form", { name: "Orders" }, LONG);
  expect(await within(detail).findByDisplayValue("Acme", {}, LONG)).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Design" }));
  await user.click(await screen.findByRole("button", { name: "Navigation" }, LONG));
  const again = await screen.findByRole("region", { name: "Navigation editor" }, LONG);
  await user.selectOptions(
    within(again).getByRole("combobox", { name: "Main form opens" }),
    "customers",
  );
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const customers = await screen.findByRole("region", { name: "Application page" }, LONG);
  await user.click(await within(customers).findByRole("row", { name: "Open 7" }, LONG));
  const related = await within(customers).findByRole("region", { name: "Orders" }, LONG);
  expect(await within(related).findByRole("cell", { name: "Rush" }, LONG)).toBeVisible();
});

it("offers to generate the app from a runtime with no table pages", async () => {
  const user = await renderNewDocument();
  await createTable("regions", [
    { name: "id", declaredType: "INTEGER", nullable: false, primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT" },
  ]);
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const page = await screen.findByRole("region", { name: "Application page" }, LONG);
  const hint = await within(page).findByRole("region", { name: "Build your app" }, LONG);
  expect(hint).toHaveTextContent("This application has no pages yet.");
  await user.click(within(hint).getByRole("button", { name: "Generate app from tables" }));
  const nav = screen.getByRole("navigation", { name: "Application navigation" });
  expect(await within(nav).findByRole("button", { name: "Regions" }, LONG)).toBeInTheDocument();
  expect(await within(page).findByRole("button", { name: "New regions" }, LONG)).toBeVisible();
  expect(within(page).queryByRole("region", { name: "Build your app" })).toBeNull();
});

it("does not offer to build the app when its only page is a dashboard", async () => {
  const user = await renderNewDocument();
  await user.click(screen.getByRole("button", { name: "Dashboards" }));
  const create = await screen.findByRole("button", { name: "New dashboard" }, LONG);
  await waitFor(() => expect(create).toBeEnabled(), LONG);
  await user.click(create);
  await waitFor(async () => {
    const config = await invoke<{ dashboards: unknown[] }>("read_document_config", {
      windowLabel: "main",
    });
    expect(config.dashboards).toHaveLength(1);
  }, LONG);
  const config = await invoke<{
    dashboards: Array<{ id: string; name: string }>;
    design: { navigation: unknown[]; startPage: string | null };
  }>("read_document_config", { windowLabel: "main" });
  const dashboard = config.dashboards[0];
  const navId = "0190a0b0-0000-7000-8000-000000000001";
  config.design.navigation = [
    { id: navId, label: dashboard.name, kind: "dashboard", targetId: dashboard.id, children: [] },
  ];
  config.design.startPage = navId;
  await invoke("update_document_config", { windowLabel: "main", config });
  const archive = join(process.env.IXTABLE_STATE_DIR ?? "", "dashboard-only.ixt");
  dialogMock.save.mockResolvedValueOnce(archive);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, LONG);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  dialogMock.open.mockResolvedValueOnce(archive);
  await user.click(await screen.findByRole("button", { name: /Open document/i }, LONG));
  await user.click(await screen.findByRole("button", { name: "Runtime" }, LONG));
  const nav = await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
  expect(
    await within(nav).findByRole("button", { name: dashboard.name }, LONG),
  ).toBeInTheDocument();
  const page = screen.getByRole("region", { name: "Application page" });
  expect(within(page).queryByRole("region", { name: "Build your app" })).toBeNull();
});

async function createLinkedTable(name: string, link?: { column: string; target: string }) {
  await invoke("create_database_table", {
    windowLabel: "main",
    spec: {
      name,
      columns: [
        { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1, nullable: false },
        { name: "name", declaredType: "TEXT", primaryKeyPosition: 0, nullable: true },
        ...(link
          ? [{ name: link.column, declaredType: "INTEGER", primaryKeyPosition: 0, nullable: true }]
          : []),
      ].map((column) => ({
        unique: false,
        defaultExpression: null,
        generatedExpression: null,
        ...column,
      })),
      foreignKeys: link
        ? [{ columns: [link.column], targetTable: link.target, targetColumns: ["id"] }]
        : [],
      checks: [],
      withoutRowid: false,
    },
  });
}

it("generates an app that passes design validation for nested and self-referencing tables", async () => {
  const user = await renderNewDocument();
  await createLinkedTable("customers");
  await createLinkedTable("orders", { column: "customer_id", target: "customers" });
  await createLinkedTable("order_lines", { column: "order_id", target: "orders" });
  await createLinkedTable("employees", { column: "manager_id", target: "employees" });
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  const page = await screen.findByRole("region", { name: "Application page" }, LONG);
  const hint = await within(page).findByRole("region", { name: "Build your app" }, LONG);
  await user.click(within(hint).getByRole("button", { name: "Generate app from tables" }));
  const nav = screen.getByRole("navigation", { name: "Application navigation" });
  expect(await within(nav).findByRole("button", { name: "Employees" }, LONG)).toBeInTheDocument();
  const issues = await invoke<Array<{ severity: string; message: string }>>("validate_design", {
    windowLabel: "main",
  });
  expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  const forms = (await design()).forms.map((form) => form.name);
  expect(forms).toContain("Orders (related)");
  expect(forms).toContain("Employees (related)");
});
