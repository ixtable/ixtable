import { createClient } from "@supabase/supabase-js";
import { test, expect } from "@playwright/test";
import { submitLogin, supabaseAvailable, uniqueEmail, waitForRecoveryLink } from "./helpers";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

test.describe("password reset", () => {
  test.skip(
    !supabaseAvailable(),
    "Supabase is not running locally; start it with `supabase start`.",
  );

  test("requests a reset link, sets a new password, and logs in with it", async ({ page }) => {
    const email = uniqueEmail("reset");
    const originalPassword = "original-password-1";
    const newPassword = "new-password-1";

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    await admin.auth.admin.createUser({ email, password: originalPassword, email_confirm: true });

    await page.goto("/");
    await page.getByTestId("navbar-login-link").click();
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await page.getByTestId("forgot-password-email-input").fill(email);
    await page.getByTestId("forgot-password-submit").click();
    await expect(page.getByTestId("reset-request-success")).toBeVisible();

    const recoveryLink = await waitForRecoveryLink(email);
    await page.goto(recoveryLink);

    await expect(page.getByTestId("reset-password-input")).toBeVisible();
    await page.getByTestId("reset-password-input").fill(newPassword);
    await page.getByTestId("reset-password-submit").click();
    await expect(page.getByTestId("reset-password-success")).toBeVisible();

    await submitLogin(page, email, newPassword);
    await expect(page.getByTestId("account-email")).toHaveText(email);
  });
});
