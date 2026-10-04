import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { captureDocument } from "../capture";
import {
  dialogMock,
  insert,
  LONG,
  openMode,
  openSettingsTab,
  renderNewDocument,
  seedSales,
  tempPath,
  type User,
} from "./fixtures";

async function exportBundle(user: User, version: string, path: string, password?: string) {
  const versionInput = await screen.findByRole("textbox", { name: "Version" }, LONG);
  await user.clear(versionInput);
  await user.type(versionInput, version);
  if (password) {
    const protect = screen.getByRole("checkbox", { name: /Protect the bundle/ });
    if (!(protect as HTMLInputElement).checked) await user.click(protect);
    await user.type(screen.getByLabelText("Password"), password);
    await user.type(screen.getByLabelText("Confirm password"), password);
  }
  dialogMock.save.mockResolvedValueOnce(path);
  await user.click(screen.getByRole("button", { name: "Export runtime bundle…" }));
  const info = await screen.findByRole("region", { name: "Exported bundle" }, LONG);
  await within(info).findByText(`Exported Untitled ${version}`, {}, LONG);
}

it("exports a protected runtime bundle, opens it runtime-only, and installs an update", async () => {
  const user = await renderNewDocument();
  await seedSales();
  // Give recipients a real page: a generated Customers list and detail form.
  await openMode(user, "Design");
  await user.selectOptions(
    await screen.findByRole("combobox", { name: "Table to generate from" }, LONG),
    "customers",
  );
  await user.click(screen.getByRole("button", { name: "Generate form from table" }));
  await screen.findByRole("button", { name: "Customers list" }, LONG);
  await openSettingsTab(user, "Release");
  const v1 = tempPath("orders-1.0.0.ixtr");
  await exportBundle(user, "1.0.0", v1, "correct horse");
  await captureDocument(document, {
    name: "release-01-exported",
    expectations: [
      "The Release tab shows version, notes, and password protection settings.",
      "The Exported bundle panel names Untitled 1.0.0 with its signer fingerprint and protection.",
    ],
  });
  const v2 = tempPath("orders-1.1.0.ixtr");
  await exportBundle(user, "1.1.0", v2, "correct horse");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Close project" }));

  dialogMock.open.mockResolvedValueOnce(v1);
  await user.click(await screen.findByRole("button", { name: /Open runtime bundle/ }, LONG));
  const prompt = await screen.findByRole("dialog", { name: /Password for Untitled 1.0.0/ }, LONG);
  await user.type(within(prompt).getByLabelText("Bundle password"), "correct horse");
  await captureDocument(document, {
    name: "release-02-password",
    expectations: ["A password dialog for Untitled 1.0.0 sits over the start screen."],
  });
  await user.click(within(prompt).getByRole("button", { name: "Unlock" }));
  const runtime = await screen.findByRole("region", { name: "Runtime bundle" }, LONG);
  expect(within(runtime).getByText("Version 1.0.0")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save project" })).not.toBeInTheDocument();
  await insert("customers", { id: 4, name: "Runtime Rita", city: "Bath" });
  const nav = screen.getByRole("navigation", { name: "Application navigation" });
  await user.click(within(nav).getByRole("button", { name: "Customers" }));
  await screen.findByRole("cell", { name: "Runtime Rita" }, LONG);
  // Runtime-only: no Studio ribbon (view, undo/redo), modes, role preview, or project breadcrumb.
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Document mode" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Preview as role" })).not.toBeInTheDocument();
  expect(screen.queryByText(/PROJECT \//)).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1, name: "Untitled" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Back to/ })).not.toBeInTheDocument();
  await captureDocument(document, {
    name: "release-03-runtime-only",
    expectations: [
      "The runtime-only window shows the app name as its title and a Runtime bundle bar with Version 1.0.0.",
      "The Customers list shows the bundled records plus the recipient's own Runtime Rita.",
      "No ribbon (Undo/Redo), mode switch, Preview as role, PROJECT breadcrumb, or Save buttons.",
    ],
  });

  dialogMock.open.mockResolvedValueOnce(v2);
  await user.click(within(runtime).getByRole("button", { name: "Check for update…" }));
  const unlock = await screen.findByRole("dialog", {}, LONG).catch(() => null);
  if (unlock) {
    await user.type(within(unlock).getByLabelText("Bundle password"), "correct horse");
    await user.click(within(unlock).getByRole("button", { name: "Unlock" }));
  }
  const apply = await screen.findByRole("dialog", { name: "Update Untitled to 1.1.0?" }, LONG);
  await user.click(within(apply).getByRole("button", { name: "Apply update" }));
  expect(
    await screen.findByText(/Updated to version 1.1.0. Your records were kept./, {}, LONG),
  ).toBeInTheDocument();
  const page = await invoke<{ total: number }>("read_table_page", {
    windowLabel: "main",
    table: "customers",
    offset: 0,
    limit: 10,
    sorts: [],
    filters: [],
  });
  expect(page.total).toBe(4);
  await captureDocument(document, {
    name: "release-04-updated",
    expectations: [
      "The Runtime bundle bar reads Version 1.1.0 with a 'records were kept' confirmation.",
    ],
  });
});

it("confirms an update with notes and migrations, a downgrade, and shows runtime diagnostics", async () => {
  const user = await renderNewDocument();
  await seedSales();
  await openSettingsTab(user, "Release");
  const v1 = tempPath("sales-1.0.0.ixtr");
  await exportBundle(user, "1.0.0", v1);
  const config = await invoke<Record<string, unknown>>("read_document_config", {
    windowLabel: "main",
  });
  await invoke("update_document_config", {
    windowLabel: "main",
    config: {
      ...config,
      migrations: [
        {
          id: "0190c3f4-eeee-7bbb-8ccc-0123456789ab",
          name: "Add delivery slots",
          order: 1,
          targetStore: "sqlite",
          up: "CREATE TABLE delivery_slots (id INTEGER PRIMARY KEY, label TEXT)",
        },
      ],
    },
  });
  await invoke("apply_migrations", { windowLabel: "main" });
  const v2 = tempPath("sales-2.0.0.ixtr");
  await invoke("export_runtime_bundle", {
    windowLabel: "main",
    path: v2,
    options: {
      version: "2.0.0",
      releaseNotes:
        "Adds delivery slots.\nFixes the order total rounding.\nFaster customer search.",
    },
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  dialogMock.open.mockResolvedValueOnce(v1);
  await user.click(await screen.findByRole("button", { name: /Open runtime bundle/ }, LONG));
  const bar = await screen.findByRole("region", { name: "Runtime bundle" }, LONG);

  dialogMock.open.mockResolvedValueOnce(v2);
  await user.click(within(bar).getByRole("button", { name: "Check for update…" }));
  const confirm = await screen.findByRole("dialog", { name: "Update Untitled to 2.0.0?" }, LONG);
  expect(within(confirm).getByText(/Fixes the order total rounding\./)).toBeInTheDocument();
  const migrations = within(confirm).getByRole("list", { name: "Migrations" });
  expect(within(migrations).getByText("Add delivery slots")).toBeInTheDocument();
  expect(within(bar).getByText("Version 1.0.0")).toBeInTheDocument();
  await captureDocument(document, {
    name: "release-05-update-confirm",
    expectations: [
      "The 'Update Untitled to 2.0.0?' dialog shows three release-note lines on separate lines.",
      "The Migrations list names 'Add delivery slots' with a collapsed SQL disclosure.",
      "The Runtime bundle bar behind still reads Version 1.0.0.",
    ],
  });
  await user.click(within(confirm).getByRole("button", { name: "Apply update" }));
  await screen.findByText(/Updated to version 2.0.0/, {}, LONG);

  dialogMock.open.mockResolvedValueOnce(v1);
  await user.click(within(bar).getByRole("button", { name: "Check for update…" }));
  const older = await screen.findByRole(
    "dialog",
    { name: "Install older version 1.0.0 of Untitled?" },
    LONG,
  );
  expect(within(older).getByText("No migrations will run on your records.")).toBeInTheDocument();
  await captureDocument(document, {
    name: "release-06-downgrade-confirm",
    expectations: [
      "The dialog asks 'Install older version 1.0.0 of Untitled?' and says no migrations will run.",
      "Cancel and a confirm button are offered; the bar behind reads Version 2.0.0.",
    ],
  });
  await user.click(within(older).getByRole("button", { name: "Cancel" }));
  expect(within(bar).getByText("Version 2.0.0")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Diagnostics…" }));
  const diagnostics = await screen.findByRole("dialog", { name: "Diagnostics" }, LONG);
  await within(diagnostics).findByText("No jobs.", {}, LONG);
  await user.click(within(diagnostics).getByRole("tab", { name: "Logs" }));
  const lines = await within(diagnostics).findByRole("list", { name: "Log entries" }, LONG);
  await waitFor(
    () => expect(within(lines).getAllByText(/Untitled 2\.0\.0/).length).toBeGreaterThan(0),
    LONG,
  );
  await captureDocument(document, {
    name: "release-07-diagnostics",
    expectations: [
      "The Diagnostics dialog has Background jobs and Logs tabs with Logs selected.",
      "Log entries include the update to Untitled 2.0.0.",
    ],
  });
});
