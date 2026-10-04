import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it } from "vitest";
import App from "../../src/App";
import {
  cloudUnavailable,
  createConfirmedUser,
  invoke as callFunction,
  uniqueEmail,
  userClient,
} from "./cloud-helpers";
import { renderNewDocument } from "./helpers";

const LONG = { timeout: 30_000 };
const skip = await cloudUnavailable(["desktop-auth-approve", "desktop-auth-exchange"]);
if (skip) console.warn(`cloud-auth: skipped (${skip})`);

describe.skipIf(!!skip)("ixtable Cloud sign-in", () => {
  let user: ReturnType<typeof userEvent.setup>;
  beforeEach(() => {
    user = userEvent.setup();
  });

  it("signs up in the Cloud tab and keeps the session only in the secret store", async () => {
    const email = uniqueEmail("auth");
    const user = await renderNewDocument();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("tab", { name: "Cloud" }, LONG));
    const card = await screen.findByRole("region", { name: "Sign in to ixtable Cloud" }, LONG);
    await user.type(within(card).getByLabelText("Email"), email);
    await user.type(within(card).getByLabelText("Password"), "correct-horse-battery");
    await user.click(within(card).getByRole("button", { name: "Create account" }));
    await screen.findByText(email, {}, LONG);
    expect(
      await screen.findByRole("region", { name: "Create a cloud application" }, LONG),
    ).toBeInTheDocument();

    expect(JSON.stringify({ ...localStorage })).not.toContain("refresh_token");
    const stored = await invoke<string | null>("cloud_auth_storage_get", {
      windowLabel: "main",
      key: "sb-ixtable-auth",
    });
    expect(stored).toContain("refresh_token");
    await expect(
      invoke("cloud_auth_storage_get", { windowLabel: "main", key: "datasource:x" }),
    ).rejects.toSatisfy(
      (e: unknown) => JSON.stringify(e).includes("VALIDATION") || String(e).includes("VALIDATION"),
    );

    await invoke("close_document", { windowLabel: "main", force: true });
    document.body.innerHTML = "";
    render(<App />);
    const section = await screen.findByRole("region", { name: "Cloud apps" }, LONG);
    await within(section).findByText(email, {}, LONG);
    await within(section).findByText("No applications have been shared with you yet.", {}, LONG);
    await user.click(within(section).getByRole("button", { name: "Sign out" }));
    await within(section).findByRole("button", { name: "Sign in to ixtable Cloud" }, LONG);
    expect(
      await invoke("cloud_auth_storage_get", { windowLabel: "main", key: "sb-ixtable-auth" }),
    ).toBeNull();
  }, 120_000);

  it("signs in through the browser hand-off with PKCE (Google/Microsoft)", async () => {
    const email = uniqueEmail("browser");
    await createConfirmedUser(email, "correct-horse-battery");
    const website = await userClient(email, "correct-horse-battery");
    render(<App />);
    const section = await screen.findByRole("region", { name: "Cloud apps" }, LONG);
    await user.click(within(section).getByRole("button", { name: "Sign in to ixtable Cloud" }));
    await user.click(within(section).getByRole("button", { name: "Sign in with Google" }));
    const address = (await within(section).findByText(/desktop-auth\?code_challenge=/, {}, LONG))
      .textContent!;
    const url = new URL(address);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("provider")).toBe("google");
    await callFunction(website, "desktop-auth-approve", {
      codeChallenge: url.searchParams.get("code_challenge"),
      state: url.searchParams.get("state"),
    });
    await within(section).findByText(email, {}, LONG);
    expect(
      await invoke<string | null>("cloud_auth_storage_get", {
        windowLabel: "main",
        key: "sb-ixtable-auth",
      }),
    ).toContain("refresh_token");
    await user.click(within(section).getByRole("button", { name: "Sign out" }));
    await within(section).findByRole("button", { name: "Sign in to ixtable Cloud" }, LONG);
  }, 120_000);
});
