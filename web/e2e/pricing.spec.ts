import { test, expect } from "@playwright/test";

test.describe("pricing", () => {
  test("navbar links to the pricing page", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation").getByRole("link", { name: "Pricing" }).first().click();
    await page.waitForURL("**/pricing/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("shows the free desktop edition and the planned Cloud price", async ({ page }) => {
    await page.goto("/pricing/");
    const free = page.getByRole("region", { name: "Free desktop" });
    await expect(free).toContainText("Apache-2.0");
    await expect(free).toContainText("SQLite and PostgreSQL");
    await expect(free).toContainText("Windows, macOS, and Linux");

    const cloud = page.getByRole("region", { name: "ixtable Cloud" });
    await expect(cloud).toContainText("Planned pricing. Subject to change before launch.");
    await expect(cloud).toContainText("US$19");
    await expect(cloud).toContainText("per cloud application per month");
    await expect(cloud).toContainText("5 runtime users");
    await expect(cloud).toContainText("US$4 per additional runtime user per month");
    await expect(cloud).toContainText("2 months free");
    await expect(cloud.getByRole("link", { name: "Join the waitlist" })).toHaveAttribute(
      "href",
      "/#waitlist",
    );
  });

  test("includes the free versus Cloud comparison table", async ({ page }) => {
    await page.goto("/pricing/");
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveText(["Capability", "Free", "Cloud"]);
    await expect(table.getByRole("row")).toHaveCount(12);
    const row = table.getByRole("row", { name: /Automatic update delivery/ });
    await expect(row.getByRole("cell")).toHaveText(["Automatic update delivery", "No", "Yes"]);
  });

  test("lists what Cloud is not", async ({ page }) => {
    await page.goto("/pricing/");
    const section = page.getByRole("region", { name: "What Cloud is not" });
    await expect(section.getByRole("listitem")).toHaveCount(6);
    await expect(section).toContainText("managed PostgreSQL");
    await expect(section).toContainText("browser runtime");
  });
});
