import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  invokeFunction: vi.fn(),
  requestPasswordReset: vi.fn(),
  listInstallationBackups: vi.fn(),
  versionReleaseNotes: vi.fn(),
  requireSession: vi.fn(),
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
  adoptSession: vi.fn(),
}));
const cloudApi = vi.hoisted(() => ({
  restoreCopy: vi.fn(),
  uploadArchive: vi.fn(),
  desktopAuthStart: vi.fn(),
  desktopAuthPoll: vi.fn(),
}));
const persistence = vi.hoisted(() => ({ archiveSizeReport: vi.fn() }));
const release = vi.hoisted(() => ({ runtimeInstallationInfo: vi.fn() }));
const session = vi.hoisted(() => ({ requestOpenSession: vi.fn() }));
vi.mock("../../src/cloud/client", () => client);
vi.mock("../../src/cloud/api", () => cloudApi);
vi.mock("../../src/persistence/api", () => persistence);
vi.mock("../../src/release/api", () => release);
vi.mock("../../src/cloud/session", () => session);

const { backupRow, decoders, invitationToken } = await import("../../src/cloud/contract");
const { updateNotice } = await import("../../src/cloud/open");
const { AcceptInvitation, SignInPanel } = await import("../../src/cloud/auth");
const { InstallationBackups } = await import("../../src/cloud/InstallationBackups");
const { UpdateDetails } = await import("../../src/release/UpdateConfirm");

const DIR = join(__dirname, "..", "..", "web", "e2e", "service-qa", "fixtures", "contract");
const recorded = (name: string) =>
  JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")).response as Record<string, unknown>;

const report = (over: boolean) => ({
  totalBytes: over ? 600_000_000 : 2048,
  recordsBytes: 1024,
  configBytes: 512,
  assetsBytes: 512,
  otherBytes: 0,
  assetShare: 0.25,
  largest: [{ id: "a1", name: "photos/site.jpg", section: "assets", bytes: 512 }],
  cloudLimitBytes: 500_000_000,
  overCloudLimit: over,
  measured: "snapshot" as const,
});

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
  for (const group of [client, cloudApi, persistence, release, session])
    for (const fn of Object.values(group)) fn.mockReset();
  client.requireSession.mockResolvedValue({ access_token: "jwt" });
});

describe("recorded replies the recipient features read", () => {
  it("an installation_backups row decodes from the backup-commit reply", () => {
    const backup = backupRow(recorded("backup-commit").backup);
    expect(backup).toEqual({
      id: "4d0213df-4045-487f-b0f5-9dd9f4e80c3a",
      installationId: "6c0015d3-6817-4894-aac5-1a10e44f7b30",
      archiveSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      archiveSize: 2048,
      createdAt: expect.any(String),
    });
    expect(() => backupRow({ id: "x" })).toThrow(/answered installation_backups without/);
  });

  it("invitations-accept decodes the membership", () => {
    expect(decoders["invitations-accept"](recorded("invitations-accept"))).toEqual({
      membership: {
        kind: "app",
        appId: "d5c5216b-2a16-48b4-86c4-488a9074a42d",
        orgId: "6baa48c5-3687-468d-952c-34e41d117128",
      },
    });
  });

  it("an invitation token comes from the emailed link or the bare token", () => {
    const token = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0";
    expect(invitationToken(`https://ixtable.app/invite?token=${token}`)).toBe(token);
    expect(invitationToken(`https://ixtable.app/invitations/accept?token=${token}&x=1`)).toBe(
      token,
    );
    expect(invitationToken(`/invite?token=${token}`)).toBe(token);
    expect(invitationToken(`  ${token}  `)).toBe(token);
    expect(invitationToken("https://ixtable.app/invite")).toBe("");
    expect(invitationToken("not a token")).toBe("");
  });
});

describe("post-update notice", () => {
  it("names the version, the migrations that ran, and the release notes with their line breaks", async () => {
    client.versionReleaseNotes.mockResolvedValue("Adds due dates.\nFixes totals.");
    release.runtimeInstallationInfo.mockResolvedValue({
      version: "2.0.0",
      lastAction: "update",
      appliedMigrations: ["Add due dates"],
    });
    expect(await updateNotice("v2", "2.0.0")).toBe(
      "Updated to version 2.0.0. Your records were kept. Migrations applied: Add due dates.\nRelease notes:\nAdds due dates.\nFixes totals.",
    );
    expect(client.versionReleaseNotes).toHaveBeenCalledWith("v2");
  });

  it("does not repeat an earlier update when this apply changed nothing", async () => {
    client.versionReleaseNotes.mockResolvedValue("Old notes.");
    release.runtimeInstallationInfo.mockResolvedValue({
      version: "2.0.0",
      lastAction: "open",
      appliedMigrations: [],
    });
    expect(await updateNotice("v2", "2.0.0")).toBe("Running version 2.0.0.");
  });

  it("keeps line breaks in the confirm step's release notes", () => {
    render(<UpdateDetails releaseNotes={"First line.\nSecond line."} migrations={[]} />);
    const notes = screen.getByText(/First line\./);
    expect(notes.textContent).toBe("First line.\nSecond line.");
    expect(notes).toHaveClass("release-notes");
  });

  it("explains an unavailable migration preview", () => {
    render(
      <UpdateDetails
        releaseNotes=""
        migrations={null}
        migrationsUnavailable="file is not a database"
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "The migration preview is unavailable (file is not a database)",
    );
  });

  it("still reports the update when notes and migrations cannot be read", async () => {
    client.versionReleaseNotes.mockRejectedValue(new Error("offline"));
    release.runtimeInstallationInfo.mockRejectedValue(new Error("gone"));
    expect(await updateNotice("v2", "2.0.0")).toBe(
      "Updated to version 2.0.0. Your records were kept. No migrations were needed.",
    );
  });
});

describe("desktop auth", () => {
  it("Forgot password sends the recovery email for the typed address", async () => {
    client.requestPasswordReset.mockResolvedValue(undefined);
    render(<SignInPanel purpose="Test" />);
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(await screen.findByText(/Enter your email address/)).toBeInTheDocument();
    expect(client.requestPasswordReset).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Email"), "ada@example.test");
    await user.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(await screen.findByText(/password reset email is on its way/)).toBeInTheDocument();
    expect(client.requestPasswordReset).toHaveBeenCalledWith("ada@example.test");
  });

  it("accepts an invitation link through invitations-accept", async () => {
    const accepted = vi.fn();
    client.invokeFunction.mockResolvedValue({
      membership: { kind: "app", appId: "a", orgId: "o" },
    });
    render(<AcceptInvitation onAccepted={accepted} />);
    await user.click(screen.getByRole("button", { name: "Accept an invitation…" }));
    await user.type(screen.getByLabelText("Invitation link"), "https://x.test/invite");
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText(/Paste the invitation link/)).toBeInTheDocument();
    expect(client.invokeFunction).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Invitation link"));
    await user.type(
      screen.getByLabelText("Invitation link"),
      "https://x.test/invite?token=abcdefghijklmnopqrstuvwxyz",
    );
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText(/Invitation accepted/)).toBeInTheDocument();
    expect(client.invokeFunction).toHaveBeenCalledWith("invitations-accept", {
      token: "abcdefghijklmnopqrstuvwxyz",
    });
    expect(accepted).toHaveBeenCalledTimes(1);
  });
});

describe("installation backups", () => {
  const backup = {
    id: "b1",
    installationId: "i1",
    archiveSha256: "a".repeat(64),
    archiveSize: 2048,
    createdAt: "2026-10-03T23:14:33Z",
  };

  it("shows the size report first and blocks an over-limit backup", async () => {
    client.listInstallationBackups.mockResolvedValue([]);
    persistence.archiveSizeReport.mockResolvedValue(report(true));
    render(<InstallationBackups appId="app" installationId="i1" />);
    await user.click(screen.getByRole("button", { name: "Back up installation" }));
    const dialog = await screen.findByRole("dialog", { name: "Backup size" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/Over the cloud limit/);
    expect(within(dialog).getByText("photos/site.jpg")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Back up now" })).toBeDisabled();
    expect(cloudApi.uploadArchive).not.toHaveBeenCalled();
  });

  it("uploads and commits a within-limit backup after confirmation", async () => {
    client.listInstallationBackups.mockResolvedValue([]);
    persistence.archiveSizeReport.mockResolvedValue(report(false));
    cloudApi.uploadArchive.mockResolvedValue({ uploadId: "u1", size: 2048, installationId: "i1" });
    client.invokeFunction.mockResolvedValue({ backup: { id: "b2" } });
    render(<InstallationBackups appId="app" installationId="i1" />);
    await user.click(screen.getByRole("button", { name: "Back up installation" }));
    const dialog = await screen.findByRole("dialog", { name: "Backup size" });
    expect(within(dialog).getByText(/Within the/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText(/Backed up 2/)).toBeInTheDocument();
    expect(client.invokeFunction).toHaveBeenCalledWith("backup-commit", {
      appId: "app",
      uploadId: "u1",
      installationId: "i1",
    });
    expect(client.listInstallationBackups).toHaveBeenCalledTimes(2);
  });

  it("restores a backup to a new local copy after the PostgreSQL warning", async () => {
    client.listInstallationBackups.mockResolvedValue([backup]);
    client.invokeFunction.mockResolvedValue({
      signedUrl: "/object/sign/x",
      sha256: backup.archiveSha256,
      size: 2048,
      isPostgres: true,
      warning: "External records are not restored.",
    });
    cloudApi.restoreCopy.mockResolvedValue({ sessionId: "s2" });
    render(<InstallationBackups appId="app" installationId="i1" />);
    const list = await screen.findByRole("list", { name: "Installation backups" });
    await user.click(within(list).getByRole("button", { name: /Restore backup from/ }));
    const dialog = await screen.findByRole("dialog", { name: "Restore backup" });
    expect(client.invokeFunction).toHaveBeenCalledWith("restore-url", {
      appId: "app",
      backupId: "b1",
    });
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "External records are not restored.",
    );
    expect(cloudApi.restoreCopy).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Restore definition only" }));
    await vi.waitFor(() =>
      expect(session.requestOpenSession).toHaveBeenCalledWith({ sessionId: "s2" }),
    );
    expect(cloudApi.restoreCopy).toHaveBeenCalledWith(
      "/object/sign/x",
      backup.archiveSha256,
      2048,
      null,
      expect.any(String),
    );
  });
});
