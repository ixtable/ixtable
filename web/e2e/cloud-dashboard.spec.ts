import { test, expect } from "./service-qa/fixture";
import { loginFromHome, openCloudApp, supabaseAvailable } from "./helpers";
import { seedPublishedApp } from "./cloud-fixtures";

test.describe("cloud dashboard", () => {
  test.skip(
    !supabaseAvailable(),
    "Supabase is not running locally; start it with `supabase start`.",
  );

  test("lists the organization's app with status, plan, and seat usage", async ({
    page,
    cloud,
  }) => {
    const { owner, app } = await seedPublishedApp(cloud);
    await loginFromHome(page, owner.email, owner.password);
    await page.getByRole("link", { name: "Cloud", exact: true }).click();
    const table = page.getByRole("region", { name: "Cloud apps" });
    const row = table.getByRole("row").filter({ hasText: app.name });
    await expect(row).toContainText("Active");
    await expect(row).toContainText("Team");
    await expect(row).toContainText("1 of 25");
    await expect(row).toContainText("of 500 MB");
    await row.getByRole("link", { name: app.name }).click();
    await expect(page.getByTestId("app-owner")).toContainText(owner.email);
  });

  test("shows versions with checksum, migrations, and the non-TLS override", async ({
    page,
    cloud,
  }) => {
    const { owner, app, sha } = await seedPublishedApp(cloud);
    await loginFromHome(page, owner.email, owner.password);
    await openCloudApp(page, app.name);
    await page.getByRole("tab", { name: "Versions" }).click();
    const version = page.getByRole("article", { name: "Version 1.2.0" });
    await expect(version).toContainText(`sha256:${sha}`);
    await expect(version).toContainText("add-orders");
    await expect(version).toContainText("Non-TLS override confirmed");
    await expect(version).toContainText("Adds the orders form.");
  });

  test("roles are read-only with the PostgreSQL enforcement limitation", async ({
    page,
    cloud,
  }) => {
    const { owner, app } = await seedPublishedApp(cloud);
    await loginFromHome(page, owner.email, owner.password);
    await openCloudApp(page, app.name);
    await page.getByRole("tab", { name: "Roles" }).click();
    await expect(page.getByTestId("roles-limitation")).toContainText(
      "least-privileged credentials",
    );
    const matrix = page.getByRole("region", { name: "Clerk object permissions" });
    await expect(matrix.getByRole("row", { name: /orders-form/ })).toContainText("Yes");
    await expect(page.getByRole("button", { name: /edit|save/i })).toHaveCount(0);
  });

  test("renames the app and turns on installation backups", async ({ page, cloud }) => {
    const { owner, app } = await seedPublishedApp(cloud);
    await loginFromHome(page, owner.email, owner.password);
    await openCloudApp(page, app.name);
    await page.getByRole("tab", { name: "Backups" }).click();
    await page.getByLabel(/Back up runtime installations/).check();
    await page.getByLabel("Keep this many archives per stream").fill("7");
    await page.getByRole("button", { name: "Save backup settings" }).click();
    await expect(page.getByTestId("backup-settings-saved")).toBeVisible();
    await page.getByRole("tab", { name: "Settings" }).click();
    await page.getByLabel("App name").fill(`${app.name} renamed`);
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByTestId("app-renamed")).toBeVisible();
    const { data } = await cloud.admin
      .from("cloud_apps")
      .select("name, backups_enabled, retention_versions")
      .eq("id", app.id)
      .single();
    expect(data).toEqual({
      name: `${app.name} renamed`,
      backups_enabled: true,
      retention_versions: 7,
    });
  });

  test("audit history lists events and filters by category", async ({ page, cloud }) => {
    const { owner, app } = await seedPublishedApp(cloud);
    await loginFromHome(page, owner.email, owner.password);
    await openCloudApp(page, app.name);
    await page.getByRole("tab", { name: "Audit history" }).click();
    const audit = page.getByRole("region", { name: "Audit history" });
    await expect(audit).toContainText("version.publish");
    await page.getByLabel("Category").selectOption({ label: "Billing" });
    await expect(page.getByText("No audit events match.")).toBeVisible();
  });

  test("creates an organization", async ({ page, cloud }) => {
    const user = await cloud.user();
    await loginFromHome(page, user.email, user.password);
    await page.getByRole("link", { name: "Cloud", exact: true }).click();
    await expect(page.getByText("You are not in an organization yet.")).toBeVisible();
    const name = `QA org ${Date.now()}`;
    await page.getByLabel("New organization name").fill(name);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page.getByRole("heading", { name: `${name} apps` })).toBeVisible();
    const { data } = await cloud.admin.from("organizations").select("id").eq("name", name).single();
    if (data) cloud.trackOrg({ id: data.id, name, created_by: user.user.id });
    await expect(page.getByRole("region", { name: "Organization members" })).toContainText("owner");
  });

  test("revokes and restores a runtime user", async ({ page, cloud }) => {
    const { owner, runtimeUser, app } = await seedPublishedApp(cloud);
    await loginFromHome(page, owner.email, owner.password);
    await openCloudApp(page, app.name);
    await page.getByRole("tab", { name: "Runtime users" }).click();
    await page.getByRole("button", { name: `Revoke ${runtimeUser.email}` }).click();
    await expect(page.getByRole("button", { name: `Restore ${runtimeUser.email}` })).toBeVisible({
      timeout: 15_000,
    });
    const { data } = await cloud.admin
      .from("app_members")
      .select("status")
      .eq("app_id", app.id)
      .eq("user_id", runtimeUser.user.id)
      .single();
    expect(data?.status).toBe("revoked");
  });

  test("credentials show metadata and the shared warning, and revoke erases the envelope", async ({
    page,
    cloud,
  }) => {
    const { owner, app } = await seedPublishedApp(cloud);
    const { error } = await cloud.admin.from("credential_envelopes").insert({
      app_id: app.id,
      datasource_id: "main-postgres",
      scope: "shared",
      ciphertext: "Y2lwaGVy",
      nonce: "bm9uY2U=",
      wrapped_dek: "d3JhcHBlZA==",
      kek_version: 1,
      created_by: owner.user.id,
    });
    expect(error).toBeNull();
    await loginFromHome(page, owner.email, owner.password);
    await openCloudApp(page, app.name);
    await page.getByRole("tab", { name: "Credentials" }).click();
    await expect(page.getByTestId("shared-credential-warning")).toBeVisible();
    await expect(page.getByRole("region", { name: "Credential envelopes" })).not.toContainText(
      "Y2lwaGVy",
    );
    await page.getByRole("button", { name: "Revoke main-postgres" }).click();
    await page
      .getByRole("dialog", { name: "Revoke this credential?" })
      .getByRole("button", { name: "Revoke credential" })
      .click();
    await expect(page.getByRole("region", { name: "Credential envelopes" })).toContainText(
      "Revoked",
      { timeout: 15_000 },
    );
    const { data } = await cloud.admin
      .from("credential_envelopes")
      .select("revoked_at")
      .eq("app_id", app.id)
      .eq("datasource_id", "main-postgres")
      .single();
    expect(data?.revoked_at).toBeTruthy();
  });

  test("the account page shows the profile, sign-in methods, and data controls", async ({
    page,
    cloud,
  }) => {
    const user = await cloud.user();
    await loginFromHome(page, user.email, user.password);
    await expect(page.getByTestId("account-email")).toHaveText(user.email);
    await expect(page.getByText("Email and password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export account data" })).toBeVisible();
    await page.getByRole("button", { name: "Delete my account" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete your account?" });
    await expect(dialog.getByRole("button", { name: "Delete account" })).toBeDisabled();
    await dialog.getByLabel(/Type .* to confirm/).fill(user.email);
    await expect(dialog.getByRole("button", { name: "Delete account" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });
});
