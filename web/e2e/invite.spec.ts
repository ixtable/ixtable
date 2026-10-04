import { randomBytes } from "node:crypto";
import { test, expect } from "./service-qa/fixture";
import { submitLogin, supabaseAvailable } from "./helpers";
import { createRole, grantSubscription, sha256Hex } from "./service-qa/seed";

async function seedInvitation(
  cloud: import("./service-qa/fixture").CloudFixture,
  opts: { subscribed?: boolean; expired?: boolean } = {},
) {
  const owner = await cloud.user();
  const org = await cloud.org(owner);
  const app = await cloud.app(org, owner);
  const role = await createRole(app.id, { name: "Clerk" });
  if (opts.subscribed !== false) await grantSubscription(app.id, "starter");
  const invitee = await cloud.user();
  const token = randomBytes(32).toString("base64url");
  const { error } = await cloud.admin.from("invitations").insert({
    kind: "app",
    app_id: app.id,
    email: invitee.email.toLowerCase(),
    role_id: role.id,
    token_hash: sha256Hex(token),
    invited_by: owner.user.id,
    ...(opts.expired ? { expires_at: new Date(Date.now() - 60_000).toISOString() } : {}),
  });
  expect(error).toBeNull();
  return { app, role, invitee, inviteLink: `/invite?token=${token}` };
}

test.describe("invitation accept", () => {
  test.skip(
    !supabaseAvailable(),
    "Supabase is not running locally; start it with `supabase start`.",
  );

  test("a signed-out invitee logs in, accepts, and becomes an active runtime user", async ({
    page,
    cloud,
  }) => {
    const { app, role, invitee, inviteLink } = await seedInvitation(cloud);
    await page.goto(inviteLink);
    await page.getByRole("link", { name: "Log in to accept" }).click();
    await submitLogin(page, invitee.email, invitee.password);
    await expect(page.getByRole("heading", { level: 1, name: "Accept invitation" })).toBeVisible();
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(page.getByTestId("invite-accepted")).toBeVisible({ timeout: 15_000 });
    const { data } = await cloud.admin
      .from("app_members")
      .select("role_id, status")
      .eq("app_id", app.id)
      .eq("user_id", invitee.user.id)
      .single();
    expect(data).toEqual({ role_id: role.id, status: "active" });
  });

  test("an expired invitation explains that a new one is needed", async ({ page, cloud }) => {
    const { invitee, inviteLink } = await seedInvitation(cloud, { expired: true });
    await page.goto(inviteLink);
    await page.getByRole("link", { name: "Log in to accept" }).click();
    await submitLogin(page, invitee.email, invitee.password);
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(page.getByTestId("invite-error")).toContainText("expired", { timeout: 15_000 });
  });

  test("an app without an active plan tells the invitee the owner must upgrade", async ({
    page,
    cloud,
  }) => {
    const { invitee, inviteLink } = await seedInvitation(cloud, { subscribed: false });
    await page.goto(inviteLink);
    await page.getByRole("link", { name: "Log in to accept" }).click();
    await submitLogin(page, invitee.email, invitee.password);
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(page.getByTestId("invite-error")).toContainText("owner must upgrade", {
      timeout: 15_000,
    });
  });
});
