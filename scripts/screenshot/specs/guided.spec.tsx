import { screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { captureDocument } from "../capture";
import {
  createTable,
  insert,
  LONG,
  openMode,
  refreshDatabase,
  renderNewDocument,
} from "./fixtures";

it("generates a three-level app from tables and opens a detail with its related list", async () => {
  const user = await renderNewDocument();
  await createTable("customers", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT" },
  ]);
  await createTable(
    "orders",
    [
      { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
      { name: "name", declaredType: "TEXT" },
      { name: "customer_id", declaredType: "INTEGER" },
    ],
    [{ columns: ["customer_id"], targetTable: "customers", targetColumns: ["id"] }],
  );
  await createTable(
    "order_lines",
    [
      { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
      { name: "name", declaredType: "TEXT" },
      { name: "order_id", declaredType: "INTEGER" },
    ],
    [{ columns: ["order_id"], targetTable: "orders", targetColumns: ["id"] }],
  );
  await insert("customers", { id: 1, name: "Northstar Goods" });
  await insert("customers", { id: 2, name: "Juniper Supply" });
  await insert("orders", { id: 10, name: "Spring restock", customer_id: 1 });
  await insert("orders", { id: 11, name: "Gift sets", customer_id: 1 });
  await insert("orders", { id: 12, name: "Trial order", customer_id: 2 });
  await insert("order_lines", { id: 100, name: "Ceramic pour-over set", order_id: 10 });
  await insert("order_lines", { id: 101, name: "Oak serving board", order_id: 10 });
  await refreshDatabase();
  await screen.findByRole("button", { name: /^order_lines\b/ }, LONG);

  await openMode(user, "Runtime");
  const page = await screen.findByRole("region", { name: "Application page" }, LONG);
  const hint = await within(page).findByRole("region", { name: "Build your app" }, LONG);
  expect(hint).toHaveTextContent("This application has no pages yet.");
  await captureDocument(document, {
    name: "guided-01-build-your-app",
    expectations: [
      "The empty Runtime page shows a 'Build your app' hint saying the application has no pages yet.",
      "The hint offers a 'Generate app from tables' primary button, with no blank starter form below it.",
    ],
  });

  await user.click(within(hint).getByRole("button", { name: "Generate app from tables" }));
  const nav = screen.getByRole("navigation", { name: "Application navigation" });
  await within(nav).findByRole("button", { name: "Order lines" }, LONG);
  expect(within(nav).getByRole("button", { name: "Customers" })).toBeInTheDocument();
  expect(within(nav).getByRole("button", { name: "Orders" })).toBeInTheDocument();
  expect(within(page).queryByRole("region", { name: "Build your app" })).toBeNull();
  await user.click(within(nav).getByRole("button", { name: "Orders" }));
  await within(page).findByRole("row", { name: "Open 10" }, LONG);
  await within(page).findAllByRole("cell", { name: "Northstar Goods" }, LONG);
  await captureDocument(document, {
    name: "guided-02-generated-list",
    expectations: [
      "The Runtime navigation lists Customers, Orders, and Order lines generated from the tables.",
      "The Orders list shows three orders with customer names instead of raw customer ids.",
    ],
  });

  await user.click(within(page).getByRole("row", { name: "Open 10" }));
  const detail = await within(page).findByRole("form", { name: "Orders" }, LONG);
  expect(await within(detail).findByDisplayValue("Northstar Goods", {}, LONG)).toBeInTheDocument();
  const lines = await within(page).findByRole("region", { name: "Order lines" }, LONG);
  expect(await within(lines).findByRole("cell", { name: "Oak serving board" }, LONG)).toBeVisible();
  expect(within(lines).getByRole("cell", { name: "Ceramic pour-over set" })).toBeVisible();
  await captureDocument(document, {
    name: "guided-03-detail-related-list",
    expectations: [
      "The Spring restock order detail shows its customer as Northstar Goods.",
      "An Order lines related list below the fields shows the two lines of this order.",
    ],
  });
});
