import { readFileSync } from "node:fs";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { captureDocument } from "../capture";
import {
  dialogMock,
  LONG,
  openMode,
  renderNewDocument,
  saveAndReopen,
  saveQuery,
  seedSales,
  tempPath,
  type User,
} from "./fixtures";

async function addComponent(user: User, band: string, kind: string) {
  await user.click(screen.getByRole("button", { name: new RegExp(`^${band} ·`) }));
  await user.click(screen.getByRole("button", { name: kind }));
}

async function setExpression(user: User, text: string) {
  const input = screen.getByRole("textbox", { name: "Expression" });
  await user.clear(input);
  await user.type(input, text);
  await waitFor(() => expect(input).toHaveValue(text));
}

it("designs a grouped report, previews it, prints, and exports a PDF", async () => {
  const user = await renderNewDocument();
  await seedSales();
  await saveQuery(
    "Orders with customers",
    "SELECT o.id, c.name AS customer, o.status, o.amount FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.status, o.id",
  );
  await saveAndReopen(user, "report.ixt");

  await openMode(user, "Reports");
  const create = await screen.findByRole("button", { name: "New report" }, LONG);
  await waitFor(() => expect(create).toBeEnabled(), LONG);
  await user.click(create);
  const name = await screen.findByRole("textbox", { name: "Report name" }, LONG);
  await user.clear(name);
  await user.type(name, "Orders by status");
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Dataset" }),
    "Query: Orders with customers",
  );
  await user.click(screen.getByRole("button", { name: "Add group" }));
  await user.selectOptions(
    await screen.findByRole("combobox", { name: "Group 1 field" }, LONG),
    "status",
  );
  await addComponent(user, "Report header", "Add text");
  const text = screen.getByRole("textbox", { name: "Text" });
  await user.clear(text);
  await user.type(text, "Orders by status");
  await addComponent(user, "Group 1 \\(record.status\\) header", "Add field");
  await user.selectOptions(screen.getByRole("combobox", { name: "Bound field" }), "status");
  await addComponent(user, "Detail", "Add field");
  await user.selectOptions(screen.getByRole("combobox", { name: "Bound field" }), "customer");
  await addComponent(user, "Detail", "Add field");
  await user.selectOptions(screen.getByRole("combobox", { name: "Bound field" }), "amount");
  const detailBand = screen.getByRole("group", { name: "Detail band" });
  const amount = within(detailBand).getByRole("button", { name: /amount/ });
  amount.focus();
  await user.keyboard("{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}");
  await addComponent(user, "Group 1 \\(record.status\\) footer", "Add calculated");
  await setExpression(user, "'Subtotal ' & format(sum(rows.amount), '#,##0.00')");
  await addComponent(user, "Report footer", "Add calculated");
  await setExpression(user, "'Grand total ' & format(sum(rows.amount), '#,##0.00')");
  await addComponent(user, "Page footer", "Add calculated");
  await setExpression(user, "'Page ' & page & ' of ' & pages");
  await captureDocument(document, {
    name: "reports-01-designer",
    expectations: [
      "The band canvas shows report header, group header/footer, detail, and footers with their components.",
      "The selected page-footer calculated field and its expression appear in the properties panel.",
    ],
  });

  await user.click(screen.getByRole("tab", { name: "Preview" }));
  const page = await screen.findByRole("img", { name: "Page 1 of 1" }, LONG);
  expect(within(page).getByText("Orders by status")).toBeInTheDocument();
  expect(within(page).getByText("Grand total 965.50")).toBeInTheDocument();
  await captureDocument(document, {
    name: "reports-02-preview",
    expectations: [
      "The preview page shows the title, one group per status with customer rows and subtotals.",
      "The grand total 965.50 and 'Page 1 of 1' footer are visible on the page.",
    ],
  });

  const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
  await user.click(screen.getByRole("button", { name: "Print" }));
  await waitFor(() => expect(print).toHaveBeenCalledOnce());
  const pdf = tempPath("orders-by-status.pdf");
  dialogMock.save.mockResolvedValueOnce(pdf);
  await user.click(screen.getByRole("button", { name: "Export PDF…" }));
  expect(await screen.findByText(`Exported PDF to ${pdf}`, {}, LONG)).toBeInTheDocument();
  expect(readFileSync(pdf).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  await captureDocument(document, {
    name: "reports-03-exported",
    expectations: ["The preview toolbar confirms the PDF export path after Print and Export."],
  });
});
