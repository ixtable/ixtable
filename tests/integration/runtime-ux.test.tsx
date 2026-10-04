import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LONG, openPage, runtimePage, startFromTemplate } from "./golden/journey";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function openWorkOrder(user: Awaited<ReturnType<typeof startFromTemplate>>, number: string) {
  await openPage(user, "Work orders");
  await user.click(await within(runtimePage()).findByRole("row", { name: `Open ${number}` }, LONG));
  return within(runtimePage()).findByRole("form", { name: "Work order" }, LONG);
}

it("Runtime record pages: one back link, yes/no cells, and each action message once", async () => {
  const user = await startFromTemplate("Work orders");
  const page = runtimePage();
  let form = await openWorkOrder(user, "WO-1001");

  const backs = within(page).getAllByRole("button", { name: /back|previous page/i });
  expect(backs.map((button) => button.getAttribute("aria-label"))).toEqual(["Back to Work orders"]);
  expect(within(form).getByRole("button", { name: "Edit" })).toBeInTheDocument();
  expect(within(form).getByRole("button", { name: "Delete" })).toBeInTheDocument();

  const tasks = await within(form).findByRole("region", { name: "Tasks" }, LONG);
  await within(tasks).findByRole("cell", { name: "Drain coolant" }, LONG);
  const done = within(tasks)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[2]?.textContent);
  expect(done).toEqual(["Yes", "Yes", "–No", "–No"]);

  within(page).getByRole("button", { name: "Back to Work orders" }).focus();
  await user.keyboard("{Enter}");
  await within(page).findByRole("row", { name: "Open WO-1002" }, LONG);
  expect(within(page).queryByRole("button", { name: /^Back to/ })).toBeNull();

  form = await openWorkOrder(user, "WO-1002");
  await user.click(await within(form).findByRole("button", { name: "Start work" }, LONG));
  await within(form).findByText("Work order started.", {}, LONG);
  expect(screen.getAllByText("Work order started.")).toHaveLength(1);
  expect(within(form).getByRole("status")).toHaveTextContent("Work order started.");
  expect(within(form).getByRole("textbox", { name: "Assignee" })).not.toHaveValue("");

  const print = within(form).getByRole("button", { name: "Print sheet" });
  await waitFor(() => expect(print).toBeEnabled(), LONG);
  await user.click(print);
  await within(page).findByRole("img", { name: "Page 1 of 1" }, LONG);
  await user.click(within(page).getByRole("button", { name: "Back to Work orders" }));
  await within(page).findByRole("row", { name: "Open WO-1001" }, LONG);
}, 120_000);

it("Runtime lists render logical booleans as Yes/No", async () => {
  const user = await startFromTemplate("Inventory");
  await openPage(user, "Products");
  const list = await within(runtimePage()).findByRole("region", { name: "Products" }, LONG);
  await within(list).findByRole("row", { name: "Open BOLT-M8" }, LONG);
  const header = within(list)
    .getAllByRole("columnheader")
    .map((th) => th.textContent);
  const active = header.indexOf("Active");
  expect(active).toBeGreaterThan(-1);
  const cells = within(list)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[active]);
  expect(cells.every((cell) => ["Yes", "–No"].includes(cell.textContent ?? ""))).toBe(true);
  expect(cells.some((cell) => cell.textContent === "Yes")).toBe(true);
}, 120_000);

type Config = {
  design: {
    forms: Array<{ id: string }>;
    navigation: Array<{ id: string; targetId?: string | null }>;
    startPage?: string | null;
  };
  roles: Array<{ permissions: Record<string, unknown> } & Record<string, unknown>>;
};

it("Studio replaces the legacy `main` form and navigation ids with UUIDv7 on open", async () => {
  await invoke("new_document", { windowLabel: "main" });
  const config = await invoke<Config>("read_document_config", { windowLabel: "main" });
  expect(config.design.forms[0].id).toMatch(UUID_V7);
  config.design.forms[0].id = "main";
  config.design.navigation[0].id = "main";
  config.design.navigation[0].targetId = "main";
  config.design.startPage = "main";
  config.roles = [
    {
      id: "r",
      name: "Clerk",
      permissions: {
        navigation: ["main"],
        objects: [{ kind: "form", id: "main", read: true }],
        actions: [],
      },
    },
  ];
  await invoke("update_document_config", { windowLabel: "main", config });
  const path = join(process.env.IXTABLE_STATE_DIR!, "legacy-main.ixt");
  await invoke("save_document_as", { windowLabel: "main", path });
  await invoke("open_document", { windowLabel: "main", path });

  const opened = await invoke<Config>("read_document_config", { windowLabel: "main" });
  const form = opened.design.forms[0].id;
  const nav = opened.design.navigation[0];
  expect(form).toMatch(UUID_V7);
  expect(nav.id).toMatch(UUID_V7);
  expect(nav.targetId).toBe(form);
  expect(opened.design.startPage).toBe(nav.id);
  expect(opened.roles[0].permissions).toMatchObject({
    navigation: [nav.id],
    objects: [{ kind: "form", id: form }],
  });
  const yaml = await invoke<string>("read_document_config_yaml", { windowLabel: "main" });
  expect(yaml).not.toMatch(/\bid: main\b/);
});
