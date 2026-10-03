import { test, expect } from "@playwright/test";
import { loginFromHome, submitLogin, supabaseAvailable } from "./helpers";
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./global-setup";

test("login page offers Google and Microsoft, disabled with an explanation when not configured", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("navbar-login-link").click();
  const google = page.getByRole("button", { name: "Continue with Google" });
  const microsoft = page.getByRole("button", { name: "Continue with Microsoft" });
  await expect(google).toBeVisible();
  await expect(microsoft).toBeVisible();
  await expect(google).toBeDisabled();
  await expect(microsoft).toBeDisabled();
  await expect(page.getByTestId("oauth-disabled-hint")).toContainText("not configured");
  await expect(page.getByRole("link", { name: "Forgot your password?" })).toBeVisible();
});

test.describe("login", () => {
  test.skip(
    !supabaseAvailable(),
    "Supabase is not running locally; start it with `supabase start`.",
  );

  test("logs in with valid credentials and lands on the account page", async ({ page }) => {
    await loginFromHome(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);
    await expect(page.getByRole("heading", { level: 1, name: "Account" })).toBeVisible();
    await expect(page.getByTestId("account-email")).toHaveText(E2E_USER_EMAIL);
    await expect(page.getByTestId("navbar-account-link")).toBeVisible();
  });

  test("shows an error for the wrong password", async ({ page }) => {
    await loginFromHome(page, E2E_USER_EMAIL, "not-the-password");
    await expect(page.getByTestId("login-error")).toBeVisible();
    await expect(page.getByTestId("navbar-login-link")).toBeVisible();
  });

  test("signs out and returns to the logged-out state", async ({ page }) => {
    await loginFromHome(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);
    await page.getByTestId("account-sign-out").click();
    await expect(page.getByRole("heading", { level: 1, name: "Log in" })).toBeVisible();
    await expect(page.getByTestId("navbar-login-link")).toBeVisible();
  });

  test("returns to the requested page after sign-in", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Cloud", exact: true }).click();
    await submitLogin(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);
    await expect(page.getByRole("heading", { level: 1, name: "Cloud dashboard" })).toBeVisible();
  });
});
