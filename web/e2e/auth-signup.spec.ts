import { test, expect } from "@playwright/test";
import { supabaseAvailable, uniqueEmail } from "./helpers";

test.describe("signup", () => {
  test.skip(
    !supabaseAvailable(),
    "Supabase is not running locally; start it with `supabase start`.",
  );

  test("creates a new account from the sign-up page and becomes authenticated", async ({
    page,
  }) => {
    const email = uniqueEmail("signup");
    await page.goto("/");
    await page.getByTestId("navbar-login-link").click();
    await page.getByRole("link", { name: "Create an account" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Create an account" })).toBeVisible();
    await expect(page.getByRole("link", { name: "terms of service", exact: true })).toBeVisible();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("a-secure-password");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("account-email")).toHaveText(email);
  });

  test("rejects a password shorter than 8 characters before calling the service", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("navbar-login-link").click();
    await page.getByTestId("login-tab-signup").click();
    await page.getByLabel("Email").fill(uniqueEmail("short"));
    await page.getByLabel("Password").fill("short");
    await page.getByTestId("login-submit").click();
    await expect(page.getByRole("heading", { level: 1, name: "Create an account" })).toBeVisible();
    await expect(page.getByTestId("account-email")).toHaveCount(0);
  });
});
