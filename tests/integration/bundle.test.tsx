import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { asTauriError } from "../../src/lib/api";
import { createTable, insertRow, readPage, renderNewDocument, value } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };
type User = Awaited<ReturnType<typeof renderNewDocument>>;
const bundlePath = (name: string) => join(process.env.IXTABLE_STATE_DIR!, name);

async function openReleaseTab(user: User) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: "Release" }));
}

async function exportBundle(user: User, version: string, path: string, password?: string) {
  const versionInput = await screen.findByRole("textbox", { name: "Version" }, LONG);
  await user.clear(versionInput);
  await user.type(versionInput, version);
  if (password) {
    const protect = screen.getByRole("checkbox", { name: /Protect the bundle/ });
    if (!(protect as HTMLInputElement).checked) await user.click(protect);
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), password);
    await user.clear(screen.getByLabelText("Confirm password"));
    await user.type(screen.getByLabelText("Confirm password"), password);
  }
  dialogMock.save.mockResolvedValueOnce(path);
  await user.click(screen.getByRole("button", { name: "Export runtime bundle…" }));
  const info = await screen.findByRole("region", { name: "Exported bundle" }, LONG);
  await within(info).findByText(`Exported Untitled ${version}`, {}, LONG);
  return info;
}

async function closeToStart(user: User) {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  await screen.findByRole("button", { name: /Open runtime bundle/ }, LONG);
}

async function seedStudioDocument() {
  const user = await renderNewDocument();
  await createTable("Customers", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT" },
  ]);
  await insertRow("Customers", [{ column: "name", value: value("text", "Ada") }]);
  return user;
}

const customerNames = async () =>
  (await readPage("Customers")).rows.map((row) => row[1]?.value).sort();

it("exports from Studio, opens runtime-only, and updates while keeping runtime records", async () => {
  const user = await seedStudioDocument();
  await openReleaseTab(user);
  await screen.findByText(/does not stop an authorized recipient/);
  const v1 = bundlePath("crm-1.0.0.ixtr");
  const info = await exportBundle(user, "1.0.0", v1);
  expect(within(info).getByText("Signer fingerprint")).toBeInTheDocument();
  expect(within(info).getByText(/^[0-9a-f]{64}$/)).toBeInTheDocument();
  const v2 = bundlePath("crm-1.1.0.ixtr");
  await exportBundle(user, "1.1.0", v2);
  await closeToStart(user);

  dialogMock.open.mockResolvedValueOnce(v1);
  await user.click(screen.getByRole("button", { name: /Open runtime bundle/ }));
  const runtime = await screen.findByRole("region", { name: "Runtime bundle" }, LONG);
  expect(within(runtime).getByText("Version 1.0.0")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Document mode" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save project" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Redo" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Preview as role" })).not.toBeInTheDocument();
  expect(screen.queryByText(/PROJECT \//)).not.toBeInTheDocument();
  expect(
    await screen.findByRole("heading", { level: 1, name: "Untitled" }, LONG),
  ).toBeInTheDocument();

  const state = await invoke<{ runtimeOnly: boolean; bundleVersion: string }>("document_state", {
    windowLabel: "main",
  });
  expect(state).toMatchObject({ runtimeOnly: true, bundleVersion: "1.0.0" });
  const config = await invoke("read_document_config", { windowLabel: "main" });
  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => "OK",
      (reason: unknown) => asTauriError(reason).code,
    );
  expect(await code(invoke("update_document_config", { windowLabel: "main", config }))).toBe(
    "READ_ONLY",
  );
  expect(
    await code(
      invoke("alter_database_table", {
        windowLabel: "main",
        table: "Customers",
        operation: { operation: "rename_table", newName: "Clients" },
      }),
    ),
  ).toBe("READ_ONLY");
  for (const command of ["apply_migrations", "rollback_migration", "dry_run_migrations"])
    expect(await code(invoke(command, { windowLabel: "main" }))).toBe("READ_ONLY");

  await insertRow("Customers", [{ column: "name", value: value("text", "Runtime Rita") }]);
  expect(await customerNames()).toEqual(["Ada", "Runtime Rita"]);

  dialogMock.open.mockResolvedValueOnce(v2);
  await user.click(within(runtime).getByRole("button", { name: "Check for update…" }));
  expect(
    await screen.findByText(/Updated to version 1.1.0. Your records were kept./, {}, LONG),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Runtime bundle" })).getByText("Version 1.1.0"),
    ).toBeInTheDocument(),
  );
  expect(await customerNames()).toEqual(["Ada", "Runtime Rita"]);

  dialogMock.open.mockResolvedValueOnce(v1);
  await user.click(screen.getByRole("button", { name: "Check for update…" }));
  expect(await screen.findByText("BUNDLE_DOWNGRADE", {}, LONG)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Install older version 1.0.0 anyway/ })).toBeEnabled();
});

it("asks for the password of a protected bundle and explains a wrong one", async () => {
  const user = await seedStudioDocument();
  await openReleaseTab(user);
  const path = bundlePath("protected.ixtr");
  const info = await exportBundle(user, "2.0.0", path, "correct horse");
  expect(within(info).getByText("Yes")).toBeInTheDocument();
  await closeToStart(user);

  dialogMock.open.mockResolvedValueOnce(path);
  await user.click(screen.getByRole("button", { name: /Open runtime bundle/ }));
  const prompt = await screen.findByRole("dialog", { name: /Password for Untitled 2.0.0/ }, LONG);
  await user.type(within(prompt).getByLabelText("Bundle password"), "wrong password");
  await user.click(within(prompt).getByRole("button", { name: "Unlock" }));
  expect(await screen.findByText("The password is incorrect.", {}, LONG)).toBeInTheDocument();

  const input = within(screen.getByRole("dialog")).getByLabelText("Bundle password");
  await user.clear(input);
  await user.type(input, "correct horse");
  await user.click(screen.getByRole("button", { name: "Unlock" }));
  const runtime = await screen.findByRole("region", { name: "Runtime bundle" }, LONG);
  expect(within(runtime).getByText("Version 2.0.0")).toBeInTheDocument();
  expect(await customerNames()).toEqual(["Ada"]);
});

it("rejects a tampered bundle before opening it", async () => {
  const user = await seedStudioDocument();
  await openReleaseTab(user);
  const path = bundlePath("tampered.ixtr");
  await exportBundle(user, "1.0.0", path);
  const { readFileSync, writeFileSync } = await import("node:fs");
  const bytes = readFileSync(path);
  bytes[bytes.length - 100] ^= 0xff;
  writeFileSync(path, bytes);
  await closeToStart(user);

  dialogMock.open.mockResolvedValueOnce(path);
  await user.click(screen.getByRole("button", { name: /Open runtime bundle/ }));
  expect(await screen.findByText("BUNDLE_SIGNATURE", {}, LONG)).toBeInTheDocument();
  await screen.findByText(/changed after it was signed/);
  expect(screen.queryByRole("region", { name: "Runtime bundle" })).not.toBeInTheDocument();
});
