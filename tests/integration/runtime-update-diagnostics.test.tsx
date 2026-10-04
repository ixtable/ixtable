import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { createTable, insertRow, renderNewDocument, value } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };
type User = Awaited<ReturnType<typeof renderNewDocument>>;
const bundlePath = (name: string) => join(process.env.IXTABLE_STATE_DIR!, name);

async function exportV1(user: User, path: string) {
  const versionInput = await screen.findByRole("textbox", { name: "Version" }, LONG);
  await user.clear(versionInput);
  await user.type(versionInput, "1.0.0");
  dialogMock.save.mockResolvedValueOnce(path);
  await user.click(screen.getByRole("button", { name: "Export runtime bundle…" }));
  const info = await screen.findByRole("region", { name: "Exported bundle" }, LONG);
  await within(info).findByText("Exported Untitled 1.0.0", {}, LONG);
}

async function addMigration() {
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
          name: "Add tags",
          order: 1,
          targetStore: "sqlite",
          up: "CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT)",
        },
      ],
    },
  });
  await invoke("apply_migrations", { windowLabel: "main" });
}

it("previews a protected update's notes and migrations, then shows jobs and logs at runtime", async () => {
  const user = await renderNewDocument();
  await createTable("Customers", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "name", declaredType: "TEXT" },
  ]);
  await insertRow("Customers", [{ column: "name", value: value("text", "Ada") }]);
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: "Release" }));
  const v1 = bundlePath("diag-1.0.0.ixtr");
  await exportV1(user, v1);
  await addMigration();
  const v2 = bundlePath("diag-2.0.0.ixtr");
  await invoke("export_runtime_bundle", {
    windowLabel: "main",
    path: v2,
    options: { version: "2.0.0", releaseNotes: "Adds tags.", password: "s3cret-pass" },
  });

  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  dialogMock.open.mockResolvedValueOnce(v1);
  await user.click(await screen.findByRole("button", { name: /Open runtime bundle/ }, LONG));
  const bar = await screen.findByRole("region", { name: "Runtime bundle" }, LONG);

  dialogMock.open.mockResolvedValueOnce(v2);
  await user.click(within(bar).getByRole("button", { name: "Check for update…" }));
  await user.type(await screen.findByLabelText("Bundle password", {}, LONG), "s3cret-pass");
  await user.click(screen.getByRole("button", { name: "Unlock" }));
  const confirm = await screen.findByRole("dialog", { name: "Update Untitled to 2.0.0?" }, LONG);
  expect(within(confirm).getByText("Adds tags.")).toBeInTheDocument();
  const migrations = within(confirm).getByRole("list", { name: "Migrations" });
  expect(within(migrations).getByText("Add tags")).toBeInTheDocument();
  expect(within(migrations).getByText(/CREATE TABLE tags/)).toBeInTheDocument();
  expect(within(bar).getByText("Version 1.0.0")).toBeInTheDocument();
  await user.click(within(confirm).getByRole("button", { name: "Apply update" }));
  await screen.findByText(/Updated to version 2.0.0/, {}, LONG);
  const objects = await invoke<{ name: string }[]>("list_database_objects", {
    windowLabel: "main",
  });
  expect(objects.map((o) => o.name)).toContain("tags");

  await user.click(screen.getByRole("button", { name: "Diagnostics…" }));
  const diagnostics = await screen.findByRole("dialog", { name: "Diagnostics" }, LONG);
  expect(within(diagnostics).getByRole("tab", { name: "Background jobs" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await within(diagnostics).findByText("No jobs.", {}, LONG);
  await user.click(within(diagnostics).getByRole("tab", { name: "Logs" }));
  const lines = await within(diagnostics).findByRole("list", { name: "Log entries" }, LONG);
  await waitFor(
    () => expect(within(lines).getAllByText(/Untitled 2\.0\.0/).length).toBeGreaterThan(0),
    LONG,
  );
  await user.click(within(diagnostics).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "Diagnostics" })).not.toBeInTheDocument();
  expect(
    await invoke<{ runtimeOnly: boolean }>("document_state", { windowLabel: "main" }),
  ).toMatchObject({ runtimeOnly: true, bundleVersion: "2.0.0" });
}, 120_000);
