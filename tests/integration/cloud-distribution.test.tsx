import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { asTauriError } from "../../src/lib/api";
import {
  cloudUnavailable,
  createConfirmedUser,
  grantSubscription,
  invoke as callFunction,
  uniqueEmail,
  userClient,
} from "./cloud-helpers";
import { readPage, value } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 60_000 };
const SALES_REP = "01a100fd-deca-7a05-8f33-87d2d2ba675b";
const skip = await cloudUnavailable();
if (skip) console.warn(`cloud-distribution: skipped (${skip})`);

type User = ReturnType<typeof userEvent.setup>;

async function signIn(user: User, scope: HTMLElement, email: string, password: string) {
  await user.type(within(scope).getByLabelText("Email"), email);
  await user.type(within(scope).getByLabelText("Password"), password);
  await user.click(within(scope).getByRole("button", { name: "Sign in" }));
  await within(scope).findByText(email, {}, LONG);
}

const cloudSection = () => screen.findByRole("region", { name: "Cloud apps" }, LONG);

async function closeToStart(user: User) {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  await cloudSection();
}

async function switchAccount(user: User, email: string, password: string) {
  const section = await cloudSection();
  const signOut = within(section).queryByRole("button", { name: "Sign out" });
  if (signOut) await user.click(signOut);
  await user.click(
    await within(section).findByRole("button", { name: "Sign in to ixtable Cloud" }, LONG),
  );
  await signIn(user, section, email, password);
}

async function openCloudTab(user: User) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: "Cloud" }));
}

async function publish(user: User, version: string) {
  const panel = await screen.findByRole("region", { name: "Publish checkpoint" }, LONG);
  const field = within(panel).getByRole("textbox", { name: "Version" });
  await user.clear(field);
  await user.type(field, version);
  const button = within(panel).getByRole("button", { name: "Publish checkpoint" });
  await waitFor(() => expect(button).toBeEnabled(), LONG);
  await user.click(button);
  await within(panel).findByText(new RegExp(`Published version ${version}`), {}, LONG);
}

describe.skipIf(!!skip)("ixtable Cloud distribution", () => {
  let user: ReturnType<typeof userEvent.setup>;
  beforeEach(() => {
    user = userEvent.setup();
  });

  it("publishes, installs with the assigned role, updates in place, and revokes", async () => {
    const password = "correct-horse-battery";
    const devEmail = uniqueEmail("developer");
    const runtimeEmail = uniqueEmail("runtime");
    const runtimeUser = await createConfirmedUser(runtimeEmail, password);
    render(<App />);

    const templates = await screen.findByRole("region", { name: "Start from a template" }, LONG);
    await user.click(
      await within(templates).findByRole("button", { name: "Create CRM from template" }, LONG),
    );
    await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
    await openCloudTab(user);
    const signInCard = await screen.findByRole(
      "region",
      { name: "Sign in to ixtable Cloud" },
      LONG,
    );
    await user.type(within(signInCard).getByLabelText("Email"), devEmail);
    await user.type(within(signInCard).getByLabelText("Password"), password);
    await user.click(within(signInCard).getByRole("button", { name: "Create account" }));
    await screen.findByText(devEmail, {}, LONG);
    const link = await screen.findByRole("region", { name: "Create a cloud application" }, LONG);
    await user.type(await within(link).findByLabelText("New organization name", {}, LONG), "Acme");
    const create = within(link).getByRole("button", { name: "Create cloud application" });
    await waitFor(() => expect(create).toBeEnabled(), LONG);
    await user.click(create);
    await screen.findByRole("region", { name: "Publish checkpoint" }, LONG);
    const config = await invoke<{ cloud: { appId: string } }>("read_document_config", {
      windowLabel: "main",
    });
    const appId = config.cloud.appId;
    await grantSubscription(appId);

    const archive = join(process.env.IXTABLE_STATE_DIR!, "crm-cloud.ixt");
    dialogMock.save.mockResolvedValueOnce(archive);
    await publish(user, "1.0.0");
    const history = await screen.findByRole("list", { name: "Version history" }, LONG);
    expect(within(history).getByText("1.0.0")).toBeInTheDocument();

    const developer = await userClient(devEmail, password);
    const invite = await callFunction<{ acceptUrl: string }>(developer, "invitations-create", {
      kind: "app",
      appId,
      email: runtimeEmail,
      roleId: SALES_REP,
    });
    const token = new URL(invite.acceptUrl).searchParams.get("token");
    const runtime = await userClient(runtimeEmail, password);
    await callFunction(runtime, "invitations-accept", { token });

    await closeToStart(user);
    await switchAccount(user, runtimeEmail, password);
    const apps = await cloudSection();
    await user.click(
      await within(apps).findByRole("button", { name: "Install cloud app CRM" }, LONG),
    );
    await screen.findByText(new RegExp(`Licensed to ${runtimeEmail}`), {}, LONG);
    const nav = await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
    expect(within(nav).getByRole("button", { name: "Deals" })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "Deal stages" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Preview as role" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Role: Sales rep", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save project" })).not.toBeInTheDocument();
    expect(screen.queryByText(/PROJECT \//)).not.toBeInTheDocument();
    await invoke("insert_row", {
      windowLabel: "main",
      table: "companies",
      values: [{ column: "name", value: value("text", "Runtime-only Ltd") }],
    });
    const refusedWrite = await invoke("insert_row", {
      windowLabel: "main",
      table: "deal_stages",
      values: [{ column: "name", value: value("text", "Hacked") }],
    }).catch((error: unknown) => asTauriError(error).code);
    expect(refusedWrite).toBe("FORBIDDEN");
    const refusedSql = await invoke("execute_read_query", {
      windowLabel: "main",
      sql: "SELECT * FROM deal_stages",
    }).catch((error: unknown) => asTauriError(error).code);
    expect(refusedSql).toBe("FORBIDDEN");
    const names = async () => (await readPage("companies")).rows.map((row) => row[1]?.value);
    expect(await names()).toContain("Runtime-only Ltd");

    await closeToStart(user);
    await switchAccount(user, devEmail, password);
    await user.click(screen.getByRole("button", { name: "Open recent crm-cloud.ixt" }));
    await screen.findByRole("button", { name: "Settings" }, LONG);
    await openCloudTab(user);
    await publish(user, "1.1.0");

    await closeToStart(user);
    await switchAccount(user, runtimeEmail, password);
    await user.click(
      await within(await cloudSection()).findByRole("button", { name: "Open cloud app CRM" }, LONG),
    );
    const bar = await screen.findByRole("region", { name: "Cloud application" }, LONG);
    await within(bar).findByText("Version 1.1.0", {}, LONG);
    expect(await names()).toContain("Runtime-only Ltd");

    const [installed] = await invoke<{ appId: string; installationId: string }[]>(
      "cloud_installed_apps",
      { windowLabel: "main" },
    );
    await callFunction(developer, "members-update", {
      appId,
      userId: runtimeUser.id,
      status: "revoked",
    });
    const refused = await callFunction(runtime, "key-grant", {
      appId,
      installationId: installed.installationId,
      datasourceId: "primary",
    }).catch((error: { code?: string }) => error);
    expect(["REVOKED", "FORBIDDEN"]).toContain((refused as { code?: string }).code);
    await closeToStart(user);
    await user.click(
      await within(await cloudSection()).findByRole("button", { name: "Open cloud app CRM" }, LONG),
    );
    const alert = await within(await cloudSection()).findByRole("alert", {}, LONG);
    expect(alert.textContent).toMatch(/REVOKED|FORBIDDEN/);
  }, 600_000);
});
