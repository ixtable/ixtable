import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { E2E_USER_EMAIL, E2E_USER_PASSWORD, SUPABASE_SERVICE_ROLE_KEY } from "./global-setup";
import { uniqueEmail, waitForRecoveryLink } from "./helpers";

const output = join(process.cwd(), "e2e", ".generated");
const supabaseUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
async function capture(page: Page, name: string, expectations: string[]) {
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  await writeFile(
    join(output, `${name}.json`),
    JSON.stringify({ name, expectations, url: page.url() }, null, 2),
  );
}
async function login(page: Page, email = E2E_USER_EMAIL, password = E2E_USER_PASSWORD) {
  await page.goto("/login");
  await page.getByTestId("login-email-input").fill(email);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit").click();
}

test("authenticated account access, valid login, and sign-out", async ({ page }) => {
  await page.goto("/account");
  await page.waitForURL("**/login");
  await expect(page.getByTestId("login-tab-signin")).toBeVisible();
  await login(page);
  await page.waitForURL("**/account");
  await expect(page.getByTestId("account-email")).toHaveText(E2E_USER_EMAIL);
  await capture(page, "service-qa-01-account", [
    "The authenticated account page displays the local test account.",
    "Account controls are visible.",
  ]);
  await page.getByTestId("account-sign-out").click();
  await page.waitForURL("**/login");
  await expect(page.getByTestId("navbar-login-link")).toBeVisible();
});

test("invalid login reports the service error", async ({ page }) => {
  await login(page, E2E_USER_EMAIL, "not-the-password");
  await expect(page.getByTestId("login-error")).toBeVisible();
  await capture(page, "service-qa-02-invalid-login", [
    "The login page shows a clear invalid-credentials error.",
    "The user remains signed out.",
  ]);
});

test("signup creates an authenticated account", async ({ page }) => {
  const email = uniqueEmail("service-signup");
  await page.goto("/login");
  await page.getByTestId("login-tab-signup").click();
  await page.getByTestId("login-email-input").fill(email);
  await page.getByTestId("login-password-input").fill("a-secure-password");
  await page.getByTestId("login-submit").click();
  await page.waitForURL("**/account");
  await expect(page.getByTestId("account-email")).toHaveText(email);
  await capture(page, "service-qa-03-signup", [
    "A newly created local Supabase user reaches the authenticated account page.",
  ]);
});

test("password reset changes credentials and restores account access", async ({ page }) => {
  const email = uniqueEmail("service-reset"),
    nextPassword = "new-password-1";
  const admin = createClient(supabaseUrl, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await admin.auth.admin.createUser({
    email,
    password: "original-password-1",
    email_confirm: true,
  });
  expect(error).toBeNull();
  await page.goto("/forgot-password");
  await page.getByTestId("forgot-password-email-input").fill(email);
  await page.getByTestId("forgot-password-submit").click();
  await expect(page.getByTestId("reset-request-success")).toBeVisible();
  const recoveryLink = await waitForRecoveryLink(email);
  await page.goto(recoveryLink);
  await page.getByTestId("reset-password-input").fill(nextPassword);
  await page.getByTestId("reset-password-submit").click();
  await expect(page.getByTestId("reset-password-success")).toBeVisible();
  await page.waitForURL("**/login");
  await login(page, email, nextPassword);
  await page.waitForURL("**/account");
  await expect(page.getByTestId("account-email")).toHaveText(email);
  await capture(page, "service-qa-04-password-reset", [
    "The reset user can authenticate and see the account page with the new password.",
  ]);
});
