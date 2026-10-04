import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import App from "../../src/App";
import { axeViolations } from "./a11y";
import { LONG, openPage, runtimePage, scalar, type User } from "./golden/journey";

let found: Record<string, string[]> = {};
let user: User;

async function audit(name: string) {
  const violations = await axeViolations();
  if (violations.length > 0) found[name] = violations;
}

async function tabTo(role: string, name: string | RegExp) {
  for (let i = 0; i < 400; i++) {
    const active = document.activeElement;
    if (active instanceof HTMLElement && screen.queryAllByRole(role, { name }).includes(active))
      return active;
    await user.tab();
  }
  throw new Error(`Tab never reached ${role} ${name}`);
}

beforeEach(() => {
  found = {};
  user = userEvent.setup();
});

it("Studio and Runtime screens have no serious or critical axe violations", async () => {
  render(<App />);
  await screen.findByRole("region", { name: "Start from a template" }, LONG);
  await audit("start screen");
  await user.click(
    await screen.findByRole("button", { name: "Create Inventory from template" }, LONG),
  );
  await screen.findByRole("navigation", { name: "Application navigation" }, LONG);

  await openPage(user, "Products");
  const product = await within(runtimePage()).findByRole("row", { name: "Open BOLT-M8" }, LONG);
  await audit("runtime list");
  await user.click(product);
  await within(runtimePage()).findByRole("form", { name: "Product" }, LONG);
  await audit("runtime detail");
  await openPage(user, "Transfers");
  await user.click(
    await within(runtimePage()).findByRole("button", { name: "New transfer" }, LONG),
  );
  await within(runtimePage()).findByRole("form", { name: "New Transfer" }, LONG);
  await audit("runtime create form");
  await openPage(user, "Inventory valuation");
  await within(runtimePage()).findByRole("img", { name: /^Page 1 of/ }, LONG);
  await audit("report preview");
  await openPage(user, "Stock overview");
  await within(runtimePage()).findByRole("region", { name: "Low-stock items" }, LONG);
  await audit("dashboard");

  await user.click(screen.getByRole("button", { name: "Data" }));
  await user.click(await screen.findByRole("button", { name: "New table" }, LONG));
  await screen.findByRole("form", { name: "Create table" }, LONG);
  await audit("data mode table designer");
  await user.click(screen.getByRole("button", { name: "Design" }));
  await screen.findByRole("region", { name: "Form builder" }, LONG);
  await audit("design mode form designer");
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  for (const tab of screen.getAllByRole("tab").map((t) => t.textContent ?? "")) {
    await user.click(screen.getByRole("tab", { name: tab }));
    await audit(`settings ${tab}`);
  }
  expect(found).toEqual({});
}, 240_000);

it("creates a record in the Runtime with the keyboard only", async () => {
  render(<App />);
  await screen.findByRole("region", { name: "Start from a template" }, LONG);
  await screen.findByRole("button", { name: "Create Inventory from template" }, LONG);
  await tabTo("button", "Create Inventory from template");
  await user.keyboard("{Enter}");
  await screen.findByRole("navigation", { name: "Application navigation" }, LONG);

  await tabTo("button", "Locations");
  await user.keyboard("{Enter}");
  await within(runtimePage()).findByRole("row", { name: "Open WH1" }, LONG);
  await tabTo("button", "New location");
  await user.keyboard("{Enter}");
  const form = await within(runtimePage()).findByRole("form", { name: "New Location" }, LONG);
  await tabTo("textbox", "Code");
  await user.keyboard("WH9");
  await tabTo("textbox", "Name");
  await user.keyboard("Overflow yard");
  await tabTo("button", "Create");
  await user.keyboard("{Enter}");
  await within(runtimePage()).findByRole("form", { name: "Location" }, LONG);
  expect(within(form).queryByRole("alert")).toBeNull();
  await waitFor(
    async () =>
      expect(await scalar("SELECT name FROM locations WHERE code = 'WH9'")).toBe("Overflow yard"),
    LONG,
  );
}, 120_000);
