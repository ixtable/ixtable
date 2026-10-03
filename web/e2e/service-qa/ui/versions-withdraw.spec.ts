import { test, expect } from "../fixture";
import { captureOutcome } from "../record";
import { createInstallation } from "../seed";
import { loginFromHome, openCloudApp } from "../../helpers";
import { seedPublishedApp } from "../../cloud-fixtures";

test("withdrawing the only installed version asks again with the installation count", async ({
  page,
  cloud,
}) => {
  const { owner, runtimeUser, app, versionId } = await seedPublishedApp(cloud);
  const installationId = await createInstallation(app.id, runtimeUser.user.id, "Front desk PC");
  await cloud.admin
    .from("installations")
    .update({ installed_version_id: versionId })
    .eq("id", installationId);
  await loginFromHome(page, owner.email, owner.password);
  await openCloudApp(page, app.name);
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.getByText("Publishing and overwrite happen in Studio")).toBeVisible();

  await page.getByRole("button", { name: "Withdraw 1.2.0" }).click();
  const dialog = page.getByRole("dialog", { name: "Withdraw version 1.2.0?" });
  await dialog.getByRole("button", { name: "Withdraw", exact: true }).click();
  await expect(dialog.getByTestId("withdraw-confirm")).toContainText(
    "1 installation runs this version",
  );
  await captureOutcome(page, "ui-versions-01-withdraw-confirm", {
    expectations: [
      "The Versions tab explains that overwrite happens in Studio (Overwrite and Fork after a conflict) and that this page forks and withdraws.",
      "After the first Withdraw, the dialog warns that this is the only published version and 1 installation runs it, and offers Withdraw anyway.",
      "The version is still published (the server refused with 422 requiresConfirm).",
    ],
    details: { appId: app.id, versionId },
  });

  await dialog.getByRole("button", { name: "Withdraw anyway" }).click();
  await expect(page.getByTestId("version-withdrawn")).toContainText(
    "Version 1.2.0 withdrawn. No version is published now.",
  );
  const article = page.getByRole("article", { name: "Version 1.2.0" });
  await expect(article).toContainText("withdrawn");
  await expect(article.getByRole("button", { name: "Withdraw 1.2.0" })).toHaveCount(0);
  const { data: row } = await cloud.admin
    .from("app_versions")
    .select("status")
    .eq("id", versionId)
    .single();
  const { data: appRow } = await cloud.admin
    .from("cloud_apps")
    .select("head_version_id")
    .eq("id", app.id)
    .single();
  expect(row?.status).toBe("withdrawn");
  expect(appRow?.head_version_id).toBeNull();
  await captureOutcome(page, "ui-versions-02-withdrawn", {
    expectations: [
      "A success notice says version 1.2.0 was withdrawn and no version is published now.",
      "The version card shows a withdrawn badge and a Withdrawn date, with no Fork or Withdraw buttons.",
      "The database row is withdrawn and the app has no head version.",
    ],
    details: { status: row?.status, head: appRow?.head_version_id },
  });
});

test("deleting an app with an active plan requires cancelling it in the dialog", async ({
  page,
  cloud,
}) => {
  const { owner, app } = await seedPublishedApp(cloud);
  await loginFromHome(page, owner.email, owner.password);
  await openCloudApp(page, app.name);
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("button", { name: `Delete ${app.name}` }).click();
  const dialog = page.getByRole("dialog", { name: `Delete ${app.name}?` });
  await dialog.getByLabel(/Type .* to confirm/).fill(app.name);
  await dialog.getByRole("button", { name: "Delete app" }).click();
  await expect(dialog.getByRole("alert")).toContainText("still has an active subscription");
  const cancel = dialog.getByLabel(/Cancel the subscription now/);
  await expect(cancel).toBeVisible();
  await captureOutcome(page, "ui-settings-01-delete-needs-cancel", {
    expectations: [
      "The delete dialog shows a 'Cancel the subscription now (team plan, active)' checkbox.",
      "Deleting without ticking it is refused with a message that the app still has an active subscription.",
    ],
    details: { appId: app.id },
  });

  await cancel.check();
  await dialog.getByRole("button", { name: "Delete app" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cloud dashboard" })).toBeVisible();
  const { data: sub } = await cloud.admin
    .from("subscriptions")
    .select("status")
    .eq("app_id", app.id)
    .single();
  const { data: appRow } = await cloud.admin
    .from("cloud_apps")
    .select("deleted_at")
    .eq("id", app.id)
    .single();
  expect(sub?.status).toBe("canceled");
  expect(appRow?.deleted_at).not.toBeNull();
  await expect(page.getByRole("link", { name: app.name, exact: true })).toHaveCount(0);
  await captureOutcome(page, "ui-settings-02-deleted", {
    expectations: [
      "With the checkbox ticked the app is deleted and the browser returns to the Cloud dashboard, which no longer lists it.",
      "The subscription row is canceled and the app row has deleted_at set.",
    ],
    details: { subscription: sub?.status, deletedAt: appRow?.deleted_at },
  });
});
