import { createHash, randomBytes } from "node:crypto";
import { test, expect } from "./service-qa/fixture";
import { submitLogin, supabaseAvailable } from "./helpers";

function desktopRequest(provider?: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const query = new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  if (provider) query.set("provider", provider);
  query.set("device", "QA laptop");
  return { verifier, challenge, state, link: `/desktop-auth?${query.toString()}` };
}

test.describe("desktop sign-in approval", () => {
  test.skip(
    !supabaseAvailable(),
    "Supabase is not running locally; start it with `supabase start`.",
  );

  test("a signed-out user logs in from the desktop link and approves the request", async ({
    page,
    cloud,
  }) => {
    const user = await cloud.user();
    const request = desktopRequest("google");
    const desktopLink = request.link;
    await page.goto(desktopLink);
    await expect(page.getByTestId("login-desktop-hint")).toContainText("Google");
    await submitLogin(page, user.email, user.password);
    await expect(
      page.getByRole("heading", { level: 1, name: "Approve desktop sign-in" }),
    ).toBeVisible();
    await expect(page.getByTestId("desktop-auth-email")).toHaveText(user.email);
    await expect(page.getByText("QA laptop")).toBeVisible();
    await expect(
      page.getByText("Approve only a sign-in you just started on your own computer"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve sign-in" }).click();
    await expect(page.getByTestId("desktop-auth-approved")).toBeVisible({ timeout: 15_000 });
    const { data } = await cloud.admin
      .from("desktop_auth_requests")
      .select("user_id, approved_at, code_challenge")
      .eq("state", request.state)
      .single();
    expect(data?.user_id).toBe(user.user.id);
    expect(data?.approved_at).toBeTruthy();
    expect(data?.code_challenge).toBe(request.challenge);
  });

  test("deny leaves the request unapproved", async ({ page, cloud }) => {
    const user = await cloud.user();
    const request = desktopRequest();
    const desktopLink = request.link;
    await page.goto(desktopLink);
    await submitLogin(page, user.email, user.password);
    await page.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByTestId("desktop-auth-denied")).toBeVisible();
    const { data } = await cloud.admin
      .from("desktop_auth_requests")
      .select("approved_at")
      .eq("state", request.state)
      .maybeSingle();
    expect(data?.approved_at ?? null).toBeNull();
  });

  test("an incomplete link is rejected without an approve button", async ({ page, cloud }) => {
    const user = await cloud.user();
    const brokenLink = "/desktop-auth?state=short";
    await page.goto(brokenLink);
    await submitLogin(page, user.email, user.password);
    await expect(page.getByTestId("desktop-auth-invalid")).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve sign-in" })).toHaveCount(0);
  });
});
