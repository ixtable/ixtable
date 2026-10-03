import { createHash, randomBytes } from "node:crypto";
import { test, expect } from "../fixture";
import { captureOutcome } from "../record";
import { createRole, grantSubscription, sha256Hex } from "../seed";
import { loginFromHome, openCloudApp, submitLogin } from "../../helpers";
import { seedPublishedApp } from "../../cloud-fixtures";

test("login page shows email sign-in and the Google and Microsoft buttons", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("navbar-login-link").click();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Microsoft" })).toBeVisible();
  await captureOutcome(page, "ui-auth-01-login", {
    expectations: [
      "The log in page shows email and password fields, a Log in button, and a forgot-password link.",
      "Continue with Google and Continue with Microsoft are visible, disabled locally, with a note that they are not configured.",
    ],
  });
});

test("cloud dashboard lists the app with plan, seats, and archive size", async ({ page, cloud }) => {
  const { owner, app } = await seedPublishedApp(cloud);
  await loginFromHome(page, owner.email, owner.password);
  await page.getByRole("link", { name: "Cloud", exact: true }).click();
  const row = page.getByRole("region", { name: "Cloud apps" }).getByRole("row").filter({ hasText: app.name });
  await expect(row).toContainText("1 of 25");
  await captureOutcome(page, "ui-cloud-01-dashboard", {
    expectations: [
      "The Cloud dashboard lists the seeded app with an Active badge, the Team plan, and 1 of 25 runtime users.",
      "The archive column shows a size meter and 3.0 MB of 500 MB.",
      "The Members section lists the signed-in owner with the owner role and an invite form.",
    ],
    details: { appId: app.id },
  });
});

test("versions tab shows the published checkpoint and its security summary", async ({ page, cloud }) => {
  const { owner, app, sha } = await seedPublishedApp(cloud, { datasourceKind: "postgres" });
  await loginFromHome(page, owner.email, owner.password);
  await openCloudApp(page, app.name);
  await page.getByRole("tab", { name: "Versions" }).click();
  await expect(page.getByRole("article", { name: "Version 1.2.0" })).toContainText(sha);
  await page.getByRole("button", { name: "Download or restore 1.2.0" }).click();
  await expect(page.getByTestId("restore-postgres-warning")).toContainText("External PostgreSQL records are not restored");
  await captureOutcome(page, "ui-cloud-02-versions-restore", {
    expectations: [
      "Version 1.2.0 shows its developer, checksum, migration add-orders, minimum Runtime 0.4.0, and release notes.",
      "The security summary shows a red Non-TLS override confirmed badge and a shared-credentials badge.",
      "The restore dialog warns that external PostgreSQL records are not restored before any download link exists.",
    ],
  });
});

test("roles tab shows the synced permission matrix and the enforcement limitation", async ({ page, cloud }) => {
  const { owner, app } = await seedPublishedApp(cloud);
  await loginFromHome(page, owner.email, owner.password);
  await openCloudApp(page, app.name);
  await page.getByRole("tab", { name: "Roles" }).click();
  await expect(page.getByTestId("roles-limitation")).toBeVisible();
  await captureOutcome(page, "ui-cloud-03-roles", {
    expectations: [
      "The Roles tab is read-only and says roles come from Studio.",
      "A warning explains that roles do not protect a direct PostgreSQL connection from a user who extracts credentials.",
      "The Clerk role shows navigation nav-orders, action send-invoice, and a matrix where orders-form has Read and Create.",
    ],
  });
});

test("billing tab shows the current plan and the plan choices", async ({ page, cloud }) => {
  const { owner, app } = await seedPublishedApp(cloud);
  await loginFromHome(page, owner.email, owner.password);
  await openCloudApp(page, app.name);
  await page.getByRole("tab", { name: "Billing" }).click();
  await expect(page.getByTestId("billing-plan")).toHaveText("Team");
  await captureOutcome(page, "ui-cloud-04-billing", {
    expectations: [
      "The Billing tab shows the Team plan, Active status, 1 of 25 runtime users, and a renewal date.",
      "Starter, Team, and Business plan cards are listed, with Team marked as the current plan.",
    ],
  });
});

test("desktop sign-in approval records the approval", async ({ page, cloud }) => {
  const user = await cloud.user();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const desktopLink = `/desktop-auth?code_challenge=${challenge}&code_challenge_method=S256&state=${state}&device=QA%20laptop`;
  await page.goto(desktopLink);
  await submitLogin(page, user.email, user.password);
  await page.getByRole("button", { name: "Approve sign-in" }).click();
  await expect(page.getByTestId("desktop-auth-approved")).toBeVisible({ timeout: 15_000 });
  const { data } = await cloud.admin.from("desktop_auth_requests").select("user_id, approved_at").eq("state", state).single();
  expect(data?.user_id).toBe(user.user.id);
  await captureOutcome(page, "ui-desktop-auth-01-approved", {
    expectations: [
      "After approval the page says the desktop sign-in was approved and to return to the desktop app.",
      "desktop_auth_requests has the request approved for the signed-in user.",
    ],
    details: { approved: Boolean(data?.approved_at) },
  });
});

test("invitation accept adds the invitee as a runtime user", async ({ page, cloud }) => {
  const owner = await cloud.user();
  const org = await cloud.org(owner);
  const app = await cloud.app(org, owner);
  const role = await createRole(app.id, { name: "Clerk" });
  await grantSubscription(app.id, "starter");
  const invitee = await cloud.user();
  const token = randomBytes(32).toString("base64url");
  await cloud.admin.from("invitations").insert({
    kind: "app",
    app_id: app.id,
    email: invitee.email.toLowerCase(),
    role_id: role.id,
    token_hash: sha256Hex(token),
    invited_by: owner.user.id,
  });
  const inviteLink = `/invite?token=${token}`;
  await page.goto(inviteLink);
  await page.getByRole("link", { name: "Log in to accept" }).click();
  await submitLogin(page, invitee.email, invitee.password);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByTestId("invite-accepted")).toBeVisible({ timeout: 15_000 });
  const { data } = await cloud.admin.from("app_members").select("status").eq("app_id", app.id).eq("user_id", invitee.user.id).single();
  expect(data?.status).toBe("active");
  await captureOutcome(page, "ui-invite-01-accepted", {
    expectations: [
      "The invite page confirms the invitation was accepted and explains how to install the app from the desktop app.",
      "app_members has the invitee as an active runtime user with the invited role.",
    ],
  });
});

test("cloud dashboard fits a phone screen", async ({ page, cloud }) => {
  const { owner, app } = await seedPublishedApp(cloud);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Toggle navigation bar" }).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Log in" }).click();
  await submitLogin(page, owner.email, owner.password);
  await page.getByRole("link", { name: "Cloud dashboard" }).click();
  const region = page.getByRole("region", { name: "Cloud apps" });
  await expect(region).toContainText(app.name);
  const box = await region.boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(390);
  await captureOutcome(page, "ui-cloud-05-mobile", {
    expectations: [
      "At 390 px wide the dashboard heading, app table, and members section stack in one column.",
      "The app table scrolls inside its own frame and the page has no horizontal scroll.",
    ],
  });
});
