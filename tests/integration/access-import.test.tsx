import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import App from "../../src/App";
import { readPage, value } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };
let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
});

function fixture(name: string) {
  const dir = mkdtempSync(join(process.env.IXTABLE_STATE_DIR!, "access-"));
  const path = join(dir, name);
  const gz = readFileSync(resolve(__dirname, "../fixtures/access", `${name}.gz`));
  writeFileSync(path, gunzipSync(gz));
  return path;
}

async function openWizard() {
  render(<App />);
  await user.click(await screen.findByRole("button", { name: /Import Access database/ }, LONG));
  const dialog = await screen.findByRole("dialog", { name: "Import Access database" });
  return dialog;
}

it("shows what an Access file holds and converts it into an open document", async () => {
  const dialog = await openWizard();
  dialogMock.open.mockResolvedValueOnce(fixture("orders.accdb"));
  await user.click(within(dialog).getByRole("button", { name: /Choose file/ }));
  const tables = await within(dialog).findByRole("table", { name: "Access tables" }, LONG);
  expect(within(tables).getByRole("cell", { name: "Customers" })).toBeInTheDocument();
  expect(within(tables).getByRole("cell", { name: "Orders" })).toBeInTheDocument();
  expect(within(dialog).getByText(/Access 2007 or later database/)).toBeInTheDocument();
  expect(within(dialog).getByRole("checkbox", { name: /Import the data/ })).toBeChecked();

  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  const report = await within(dialog).findByRole("region", { name: "Access import report" }, LONG);
  expect(within(report).getByText(/Created a document with 2 tables/)).toBeInTheDocument();
  const objects = within(report).getByRole("table", { name: "Converted objects" });
  expect(within(objects).getByRole("rowheader", { name: "Tables" })).toBeInTheDocument();
  expect(within(objects).getByRole("rowheader", { name: "Queries" })).toBeInTheDocument();
  expect(within(report).getByText(/What did not convert fully/)).toBeInTheDocument();

  await user.click(within(dialog).getByRole("button", { name: "Open document" }));
  expect(screen.queryByRole("dialog", { name: "Import Access database" })).toBeNull();
  const orders = await readPage("Orders");
  expect(orders.total).toBe(8);
  expect(orders.columns.map((c) => c.name)).toContain("Customer");
  const customers = await readPage("Customers");
  expect(customers.rows[0][0]).toEqual(value("integer", 1));
});

it("imports only the structure when the data option is off", async () => {
  const dialog = await openWizard();
  dialogMock.open.mockResolvedValueOnce(fixture("orders.mdb"));
  await user.click(within(dialog).getByRole("button", { name: /Choose file/ }));
  await within(dialog).findByText(/Access 2000–2003 database/, {}, LONG);
  await user.click(within(dialog).getByRole("checkbox", { name: /Import the data/ }));
  await user.click(within(dialog).getByRole("button", { name: "Import" }));
  await within(dialog).findByText(/Created a document with 2 tables and 0 rows/, {}, LONG);
  await user.click(within(dialog).getByRole("button", { name: "Open document" }));
  expect((await readPage("Orders")).total).toBe(0);
});

it("explains why a file cannot be read", async () => {
  const dialog = await openWizard();
  const dir = mkdtempSync(join(process.env.IXTABLE_STATE_DIR!, "access-"));
  const path = join(dir, "notes.accdb");
  writeFileSync(path, "not a database");
  dialogMock.open.mockResolvedValueOnce(path);
  await user.click(within(dialog).getByRole("button", { name: /Choose file/ }));
  expect(await within(dialog).findByRole("alert", {}, LONG)).toHaveTextContent(
    /not an Access database/,
  );
  expect(within(dialog).getByRole("button", { name: "Import" })).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Import Access database" })).toBeNull();
});
