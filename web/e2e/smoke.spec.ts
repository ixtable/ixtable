import { test, expect } from "@playwright/test";

test.describe("smoke", () => {
  test("home page renders", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText(/Build the app\s*your business needs\./);
    await expect(page.getByRole("link", { name: "Docs" }).first()).toBeVisible();
  });

  test("docs and cloud docs render from the navbar and sidebar", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Docs", exact: true }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    await page.getByRole("link", { name: "Security", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Security model" })).toBeVisible();
  });

  test("pricing lists the three plans for signed-out visitors", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Pricing", exact: true }).first().click();
    for (const plan of ["Starter", "Team", "Business"]) {
      await expect(page.getByRole("region", { name: `${plan} plan` })).toBeVisible();
    }
    await expect(page.getByRole("region", { name: "Team plan" })).toContainText("25 runtime users");
  });

  test("footer links to the privacy policy and terms", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Terms of service" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Terms of service" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "The trusted-user security model" }),
    ).toBeVisible();
  });

  test("navbar shows a login link when signed out", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("navbar-login-link")).toBeVisible();
  });
});
