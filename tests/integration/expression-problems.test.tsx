import { render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { PublishPanel } from "../../src/cloud/PublishPanel";
import { DocumentConfigProvider } from "../../src/lib/config-store";
import { ShellContext, type ShellApi } from "../../src/shell/context";
import { createTable, renderNewDocument } from "./helpers";
import { dialogMock } from "./setup";

vi.mock("../../src/cloud/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/cloud/client")>()),
  runtimeCapacity: async () => 1,
}));

const LONG = { timeout: 20_000 };

it("lists expression errors in Problems, opens the owning control, and blocks bundle export", async () => {
  const user = await renderNewDocument();
  await createTable("orders", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "total", declaredType: "INTEGER" },
  ]);

  await user.click(screen.getByRole("button", { name: "Design" }));
  await screen.findByRole("region", { name: "Form builder" }, LONG);
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Table to generate from" }),
    "orders",
  );
  await user.click(screen.getByRole("button", { name: "Generate form from table" }));
  const forms = screen.getByRole("region", { name: "Forms" });
  await within(forms).findByRole("button", { name: "Orders list" }, LONG);
  const properties = screen.getByRole("complementary", { name: "Properties" });
  await user.click(await screen.findByRole("group", { name: "Total" }, LONG));
  const visible = within(properties).getByRole("textbox", { name: "Visible when" });
  await user.type(visible, "record.total >");
  await waitFor(() => expect(visible).toHaveAttribute("aria-invalid", "true"));

  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(screen.getByRole("tab", { name: "Problems" }));
  const list = await screen.findByRole("list", { name: "Problems" }, LONG);
  const item = (await within(list).findByText(/Control "Total" › Visible when/, {}, LONG)).closest(
    "li",
  ) as HTMLElement;
  expect(item).toHaveClass("issue-error");
  expect(item).toHaveTextContent("Unexpected end of expression");

  await user.click(screen.getByRole("tab", { name: "Release" }));
  dialogMock.save.mockClear();
  await user.click(await screen.findByRole("button", { name: "Export runtime bundle…" }, LONG));
  const alert = await screen.findByRole("alert", {}, LONG);
  expect(alert).toHaveTextContent("EXPRESSION_ERRORS");
  expect(alert).toHaveTextContent("Settings › Problems");
  expect(dialogMock.save).not.toHaveBeenCalled();

  await user.click(screen.getByRole("tab", { name: "Problems" }));
  const again = await screen.findByRole("list", { name: "Problems" }, LONG);
  await user.click(within(again).getAllByRole("button", { name: /^Open form Orders/ })[0]!);
  const opened = await screen.findByRole("complementary", { name: "Properties" }, LONG);
  const field = await within(opened).findByRole("textbox", { name: "Visible when" }, LONG);
  expect(field).toHaveValue("record.total >");
  expect(field).toHaveAttribute("aria-invalid", "true");

  await user.clear(field);
  await user.type(field, "record.total > 0");
  await waitFor(() => expect(field).not.toHaveAttribute("aria-invalid"));
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(await screen.findByRole("tab", { name: "Problems" }, LONG));
  await screen.findByText(/^0 errors,/, {}, LONG);
  expect(screen.queryByText(/Control "Total" › Visible when/)).not.toBeInTheDocument();
});

it("blocks cloud publish while an expression has errors", async () => {
  await invoke("new_document", { windowLabel: "main" });
  const config = await invoke<Record<string, unknown>>("read_document_config", {
    windowLabel: "main",
  });
  const dashboard = {
    id: "0190f7a2-0000-7000-8000-000000000001",
    name: "Ops",
    layout: { columns: [{ kind: "fr", value: 1 }], rows: [], columnGap: 8, rowGap: 8 },
    filters: [],
    components: [
      {
        id: "0190f7a2-0000-7000-8000-000000000002",
        kind: "text",
        title: "Note",
        placement: { column: 1, row: 1, columnSpan: 1, rowSpan: 1 },
        text: "Hello",
        visibleWhen: "params.region =",
      },
    ],
  };
  await invoke("update_document_config", {
    windowLabel: "main",
    config: {
      ...config,
      dashboards: [dashboard],
      cloud: { appId: "app-1", orgId: "org-1", headVersionId: null },
    },
  });
  const shell = {
    applySession: () => undefined,
    save: async () => undefined,
  } as unknown as ShellApi;
  render(
    <DocumentConfigProvider>
      <ShellContext.Provider value={shell}>
        <PublishPanel app={null} onPublished={() => undefined} />
      </ShellContext.Provider>
    </DocumentConfigProvider>,
  );
  const panel = await screen.findByRole("region", { name: "Publish checkpoint" }, LONG);
  const blockers = await within(panel).findByRole("alert", { name: "Publishing is blocked" }, LONG);
  expect(blockers).toHaveTextContent(
    "1 expression error must be fixed first (see Settings › Problems)",
  );
  expect(within(panel).getByRole("button", { name: "Publish checkpoint" })).toBeDisabled();
});
