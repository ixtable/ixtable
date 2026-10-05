import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { captureDocument } from "../capture";
import { LONG, openMode, startFromTemplate } from "./fixtures";

const nav = () => screen.getByRole("navigation", { name: "Application navigation" });
const page = () => screen.getByRole("region", { name: "Application page" });

it("starts from the CRM template", async () => {
  const user = await startFromTemplate("CRM");
  expect(screen.getByText("CRM")).toBeInTheDocument();
  await waitFor(() => expect(within(page()).queryByText(/Loading/)).toBeNull(), LONG);
  await captureDocument(document, {
    name: "templates-01-crm-runtime",
    expectations: [
      "The CRM opens in the Runtime with its navigation (companies, contacts, deals, activities).",
      "The landing page shows live sample data rather than an empty state.",
    ],
  });
  await openMode(user, "Data");
  await waitFor(() =>
    expect(document.querySelectorAll(".react-flow__node").length).toBeGreaterThan(3),
  );
  await captureDocument(document, {
    name: "templates-02-crm-relationships",
    selector: ".flow-browser",
    viewport: { width: 1440, height: 900 },
    expectations: ["Every CRM table appears with labelled relationships between keys."],
  });
});

it("starts from the Inventory template", async () => {
  const user = await startFromTemplate("Inventory");
  const first = within(nav()).getAllByRole("button")[1];
  await user.click(first);
  await within(page()).findAllByRole("row", { name: /^Open / }, LONG);
  await captureDocument(document, {
    name: "templates-03-inventory-runtime",
    expectations: [
      "The Inventory app opens with its navigation and a list page of sample records.",
    ],
  });
});

it("starts from the Work orders template and shows its operations dashboard", async () => {
  await startFromTemplate("Work orders");
  await within(page()).findByRole("img", { name: /chart/i }, LONG);
  await captureDocument(document, {
    name: "templates-04-work-orders-dashboard",
    expectations: [
      "The Operations dashboard shows KPI tiles and a chart built from the template's queries.",
      "Navigation groups Maintenance, Reports, and Setup are visible.",
      "The Open work order list table fits its card, assignee and progress columns included.",
    ],
  });
});
