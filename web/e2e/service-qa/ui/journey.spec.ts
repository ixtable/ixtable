/**
 * End-to-end cloud journey across the website and the functions the desktop
 * calls: an owner signs up on the website and creates an organization; the
 * app is created, its roles synced and a real CRM archive (made by the
 * desktop's Rust code, fixtures/crm.ixt) published exactly as Studio does;
 * the owner pays through the fake checkout, invites a Runtime User who
 * accepts from the emailed link, and then sees the member, the version and
 * the audit trail. Billing comes before publishing and inviting because both
 * need an entitled app.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callFunction, localStack } from "../clients";
import { expect, test } from "../fixture";
import { captureOutcome } from "../record";
import { randomPassword, signIn, uniqueEmail } from "../seed";
import { submitLogin } from "../../helpers";

const FIXTURES = join(__dirname, "..", "fixtures");
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

/** The invitation token from the newest email to `email` (accept link in redirect_to). */
async function invitationToken(email: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const list = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)
    ).json()) as { messages: { ID: string }[] };
    for (const { ID } of list.messages ?? []) {
      const { Text } = (await (await fetch(`${MAILPIT}/api/v1/message/${ID}`)).json()) as {
        Text: string;
      };
      const redirect = /redirect_to=([^\s)&]+)/.exec(Text)?.[1];
      const token = redirect && new URL(decodeURIComponent(redirect)).searchParams.get("token");
      if (token) return token;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no invitation email for ${email}`);
}

test("owner signs up, publishes, bills and invites; the runtime user accepts", async ({
  page,
  browser,
  cloud,
}) => {
  test.setTimeout(180_000);
  const ownerEmail = uniqueEmail("journey-owner");
  const password = randomPassword();
  const runtime = await cloud.user();

  // 1. Sign up on the website and create an organization.
  await page.goto("/signup");
  await page.getByLabel("Email").fill(ownerEmail);
  await page.getByLabel("Password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("account-email")).toHaveText(ownerEmail);
  const owner = await signIn(ownerEmail, password);
  cloud.trackUser(owner);
  await page.getByRole("link", { name: "Cloud", exact: true }).click();
  await page.getByLabel("New organization name").fill("Journey Traders");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/cloud\?org=/);
  const orgId = new URL(page.url()).searchParams.get("org") ?? "";
  cloud.trackOrg({ id: orgId, name: "Journey Traders", created_by: owner.user.id });

  // 2. Studio links the document: apps-create and roles-sync with the owner's session.
  const roles = JSON.parse(readFileSync(join(FIXTURES, "crm.roles.json"), "utf8")) as {
    id: string;
    name: string;
  }[];
  const created = await callFunction<{ app: { id: string; name: string } }>("apps-create", {
    jwt: owner.jwt,
    body: { orgId, name: "Journey CRM", documentId: randomUUID() },
  });
  expect(created.status).toBe(200);
  const app = created.body.app;
  const synced = await callFunction("roles-sync", {
    jwt: owner.jwt,
    body: { appId: app.id, roles },
  });
  expect(synced.status).toBe(200);

  // 3. Billing: choose a plan, pay at the test checkout, the badge turns Active.
  await page.goto(`/cloud/app?id=${app.id}&tab=billing`);
  await expect(page.getByText("No plan").first()).toBeVisible();
  await page.getByRole("button", { name: "Choose Team" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Test checkout" })).toBeVisible();
  await page.getByRole("button", { name: "Complete test payment" }).click();
  await expect(page.getByTestId("fake-checkout-done")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: "Back to billing" }).click();
  await expect(page.getByTestId("billing-plan")).toHaveText("Team");
  await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
  await captureOutcome(page, "ui-journey-01-billing-active", {
    expectations: [
      "After the test checkout the app header and the Billing tab show an Active badge.",
      "The current plan is Team with 0 of 25 runtime users, and the Team card is marked Current plan.",
    ],
    details: { appId: app.id, orgId },
  });

  // 4. Studio publishes the CRM archive: upload URL, PUT, publish-checkpoint.
  const bytes = readFileSync(join(FIXTURES, "crm.ixt"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const upload = await callFunction<{ uploadId: string; signedUrl: string }>("archive-upload-url", {
    jwt: owner.jwt,
    body: { appId: app.id, kind: "version", size: bytes.length, sha256 },
  });
  expect(upload.status).toBe(200);
  const put = await fetch(upload.body.signedUrl, {
    method: "PUT",
    headers: {
      apikey: localStack().anonKey,
      "content-type": "application/octet-stream",
      "x-upsert": "false",
    },
    body: new Uint8Array(bytes),
  });
  expect(put.status).toBe(200);
  const published = await callFunction<{ version: { id: string } }>("publish-checkpoint", {
    jwt: owner.jwt,
    body: {
      appId: app.id,
      uploadId: upload.body.uploadId,
      version: "1.0.0",
      releaseNotes: "First CRM release.",
      minRuntimeVersion: "0.1.0",
      migrations: [],
      security: { store: "sqlite", tls: true, concurrencyPoliciesResolved: true },
      expectedHeadVersionId: null,
    },
  });
  expect(published.status, JSON.stringify(published.body)).toBe(200);

  // 5. The owner invites the Runtime User on the website.
  await page.getByRole("tab", { name: "Runtime users" }).click();
  await page.getByLabel("Email").fill(runtime.email);
  await page.getByLabel("Runtime role").selectOption({ label: "Sales rep" });
  await page.getByRole("button", { name: "Invite runtime user" }).click();
  await expect(page.getByTestId("app-invite-sent")).toContainText(runtime.email);

  // 6. The Runtime User accepts from the emailed link in their own browser.
  const token = await invitationToken(runtime.email);
  const invitee = await browser.newContext();
  const invitePage = await invitee.newPage();
  await invitePage.goto(`/invite?token=${encodeURIComponent(token)}`);
  await invitePage.getByRole("link", { name: "Log in to accept" }).click();
  await submitLogin(invitePage, runtime.email, runtime.password);
  await invitePage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitePage.getByTestId("invite-accepted")).toBeVisible({ timeout: 15_000 });
  await captureOutcome(invitePage, "ui-journey-02-invite-accepted", {
    expectations: [
      "The runtime user, signed in on their own browser from the emailed link, sees Invitation accepted.",
      "The page explains how to install the app from the desktop app's Cloud apps list.",
    ],
  });
  await invitee.close();

  // 7. The owner sees the member, the version and the audit trail.
  await page.reload();
  await page.getByRole("tab", { name: "Runtime users" }).click();
  const members = page.getByRole("region", { name: "Runtime users" }).last();
  await expect(members).toContainText(runtime.email);
  await expect(members.getByLabel(`Role for ${runtime.email}`)).toHaveValue(roles[0].id);
  await captureOutcome(page, "ui-journey-03-member", {
    expectations: [
      "The Runtime users tab lists the invitee as an active runtime user with the Sales rep role.",
      "No pending invitation remains for the invitee.",
    ],
  });
  await page.getByRole("tab", { name: "Versions" }).click();
  const version = page.getByRole("article", { name: "Version 1.0.0" });
  await expect(version).toContainText(sha256);
  await captureOutcome(page, "ui-journey-04-version", {
    expectations: [
      "Version 1.0.0 is the head and published, with the checksum of the CRM archive made by the desktop and its size.",
      "The developer is the owner's email and the release notes read First CRM release.",
    ],
    details: { sha256, size: bytes.length },
  });
  await page.getByRole("tab", { name: "Audit history" }).click();
  const audit = page.getByRole("region", { name: "Audit history" }).last();
  for (const action of ["app.create", "version.publish", "invitation.accept"])
    await expect(audit).toContainText(action);
  await captureOutcome(page, "ui-journey-05-audit", {
    expectations: [
      "The audit history lists app.create, role sync, the billing events, version.publish, invitation.create and invitation.accept.",
      "Each row names the actor (owner or runtime user) and the time.",
    ],
  });
});
