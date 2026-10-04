import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App";
import { CommandError } from "../../src/lib/api";
import type { UpdateProgress, UpdateSettings } from "../../src/updates/types";
import { resetUpdateState } from "../../src/updates/useUpdater";
import { createTable, renderNewDocument } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };
type User = Awaited<ReturnType<typeof renderNewDocument>>;

const updater = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  progress: vi.fn(),
  relaunch: vi.fn(),
}));
vi.mock("../../src/updates/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/updates/api")>()),
  checkForUpdate: updater.check,
  installUpdate: updater.install,
  updateProgress: updater.progress,
  relaunchApp: updater.relaunch,
}));

const release = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  channel: "beta",
  date: "2026-10-01 00:00:00.0 +00:00:00",
  notes: "Faster grids.",
};
let progress: UpdateProgress = { phase: "idle", downloaded: 0, total: null };

beforeEach(async () => {
  resetUpdateState();
  progress = { phase: "idle", downloaded: 0, total: null };
  updater.check.mockReset().mockResolvedValue(null);
  updater.progress.mockReset().mockImplementation(async () => progress);
  updater.relaunch.mockReset().mockResolvedValue(undefined);
  updater.install.mockReset().mockImplementation(async () => {
    progress = { phase: "downloading", downloaded: 512, total: 1024 };
    await new Promise((resolve) => setTimeout(resolve, 600));
    progress = { phase: "installed", downloaded: 1024, total: 1024 };
  });
  await invoke("set_update_settings", { windowLabel: "main", channel: "stable", autoCheck: true });
});

const settings = () => invoke<UpdateSettings>("update_settings", { windowLabel: "main" });

async function giveDocumentAFile(name: string) {
  const path = join(process.env.IXTABLE_STATE_DIR!, name);
  await invoke("save_document_as", { windowLabel: "main", path });
}

async function openUpdates(user: User) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: "Updates" }));
  await screen.findByText("0.1.0", {}, LONG);
}

it("stores the channel and auto-check, then checks, downloads, installs, and relaunches", async () => {
  const user = await renderNewDocument();
  await giveDocumentAFile("updates-flow.ixt");
  await openUpdates(user);
  expect(screen.getByRole("combobox", { name: "Update channel" })).toHaveValue("stable");

  await user.selectOptions(screen.getByRole("combobox", { name: "Update channel" }), "beta");
  await waitFor(async () => expect((await settings()).channel).toBe("beta"));
  expect((await settings()).endpoint).toMatch(
    /^https:\/\/releases\.ixtable\.app\/beta\/latest\.json\?target=\{\{target\}\}/,
  );
  await user.click(screen.getByRole("checkbox", { name: "Check for updates when ixtable starts" }));
  await waitFor(async () => expect((await settings()).autoCheck).toBe(false));
  expect(await invoke("get_preference", { windowLabel: "main", key: "updates.channel" })).toBe(
    "beta",
  );

  updater.check.mockResolvedValueOnce(null);
  await user.click(screen.getByRole("button", { name: "Check for updates" }));
  expect(await screen.findByText("ixtable is up to date.", {}, LONG)).toBeInTheDocument();

  updater.check.mockResolvedValueOnce(release);
  await user.click(screen.getByRole("button", { name: "Check for updates" }));
  const offer = await screen.findByRole("region", { name: "Available update" }, LONG);
  expect(offer).toHaveTextContent("ixtable 0.2.0 is available");
  expect(offer).toHaveTextContent("Faster grids.");

  await user.click(within(offer).getByRole("button", { name: "Install and relaunch" }));
  expect(await screen.findByText(/Downloaded 512 B of 1\.0 KB \(50%\)/, {}, LONG)).toBeVisible();
  expect(screen.getByRole("progressbar", { name: "Update download" })).toBeInTheDocument();
  await waitFor(() => expect(updater.relaunch).toHaveBeenCalledTimes(1), LONG);
  expect(await screen.findByText("Update installed.")).toBeInTheDocument();
});

it("saves unsaved work before installing, and cancelling installs nothing", async () => {
  const user = await renderNewDocument();
  await createTable("Customers", [{ name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 }]);
  expect(await invoke("document_state", { windowLabel: "main" })).toMatchObject({ dirty: true });
  await openUpdates(user);
  updater.check.mockResolvedValueOnce(release);
  await user.click(screen.getByRole("button", { name: "Check for updates" }));
  await user.click(await screen.findByRole("button", { name: "Install and relaunch" }, LONG));

  let prompt = await screen.findByRole("alertdialog", { name: "Save changes before updating?" });
  await user.click(within(prompt).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(updater.install).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Install and relaunch" }));
  prompt = await screen.findByRole("alertdialog");
  dialogMock.save.mockResolvedValueOnce(null);
  await user.click(within(prompt).getByRole("button", { name: "Save and install" }));
  expect(await within(prompt).findByText(/changes were not saved/, {}, LONG)).toBeVisible();
  expect(updater.install).not.toHaveBeenCalled();

  const path = join(process.env.IXTABLE_STATE_DIR!, "before-update.ixt");
  dialogMock.save.mockResolvedValueOnce(path);
  await user.click(within(prompt).getByRole("button", { name: "Save and install" }));
  await waitFor(() => expect(updater.install).toHaveBeenCalledTimes(1), LONG);
  expect(await invoke("document_state", { windowLabel: "main" })).toMatchObject({
    dirty: false,
    path,
  });
  await waitFor(() => expect(updater.relaunch).toHaveBeenCalledTimes(1), LONG);
});

it("reports a package that fails signature verification and does not relaunch", async () => {
  const user = await renderNewDocument();
  await giveDocumentAFile("updates-signature.ixt");
  await openUpdates(user);
  updater.check.mockResolvedValueOnce(release);
  updater.install.mockRejectedValueOnce(
    new CommandError("UPDATE_SIGNATURE_INVALID", "minisign: signature verification failed"),
  );
  await user.click(screen.getByRole("button", { name: "Check for updates" }));
  await user.click(await screen.findByRole("button", { name: "Install and relaunch" }, LONG));
  const alert = await screen.findByRole("alert", {}, LONG);
  expect(alert).toHaveTextContent("UPDATE_SIGNATURE_INVALID");
  expect(alert).toHaveTextContent("failed signature verification and was not installed");
  expect(screen.queryByRole("region", { name: "Available update" })).not.toBeInTheDocument();
  expect(updater.relaunch).not.toHaveBeenCalled();
});

it("checks on start only when enabled, and only offers the update", async () => {
  await invoke("set_update_settings", { windowLabel: "main", autoCheck: false });
  const { unmount } = render(<App />);
  await screen.findByRole("button", { name: /New document/i }, LONG);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(updater.check).not.toHaveBeenCalled();
  unmount();

  resetUpdateState();
  await invoke("set_update_settings", { windowLabel: "main", autoCheck: true });
  updater.check.mockResolvedValueOnce({ ...release, version: "0.3.0", channel: "stable" });
  render(<App />);
  const banner = await screen.findByText("ixtable 0.3.0 is available.", {}, LONG);
  expect(updater.check).toHaveBeenCalledTimes(1);
  expect(updater.install).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Review update" }));
  expect(await screen.findByRole("region", { name: "Available update" }, LONG)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss update notice" }));
  expect(banner).not.toBeInTheDocument();
});
