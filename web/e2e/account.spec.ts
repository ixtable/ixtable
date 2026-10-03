import { test, expect } from "@playwright/test";

test("signed-out visit to the Cloud dashboard asks the visitor to log in", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Cloud", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Log in" })).toBeVisible();
  await expect(page.getByTestId("login-tab-signin")).toBeVisible();
});
