import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { createTable, readPage, renderNewDocument } from "./helpers";
import { dialogMock } from "./setup";

const LONG = { timeout: 20_000 };

type Config = {
  design: {
    forms: Array<Record<string, unknown> & { id: string }>;
    navigation: Array<Record<string, unknown>>;
  };
} & Record<string, unknown>;

const id = () => crypto.randomUUID();
const at = (row: number, columnSpan = 12) => ({ column: 1, row, columnSpan, rowSpan: 1 });
const grid = () => ({
  columns: Array.from({ length: 12 }, () => ({ kind: "fr", value: 1 })),
  rows: [],
  columnGap: 16,
  rowGap: 16,
  padding: 0,
  justifyItems: "stretch",
  alignItems: "stretch",
  namedRegions: [],
  breakpoints: [],
});

async function seedTicketForm() {
  await createTable("tickets", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "title", declaredType: "TEXT" },
    { name: "priority", declaredType: "INTEGER" },
    { name: "notes", declaredType: "TEXT" },
  ]);
  const config = await invoke<Config>("read_document_config", { windowLabel: "main" });
  const form = config.design.forms[0];
  const tabs = id();
  const [general, planning] = [id(), id()];
  const section = id();
  const field = (label: string, column: string, parent: unknown, required = false) => ({
    id: id(),
    kind: column === "priority" ? "number" : "text",
    label,
    binding: { column },
    validation: { required },
    placement: at(1, 6),
    parent,
  });
  config.design.forms[0] = {
    ...form,
    name: "Ticket",
    source: { kind: "table", table: "tickets" },
    modes: ["create", "edit", "list", "detail"],
    layout: grid(),
    listColumns: [],
    rules: [],
    controls: [
      {
        id: tabs,
        kind: "tabs",
        label: "Ticket tabs",
        validation: { required: false },
        placement: at(1),
        layout: grid(),
        tabs: [
          { id: general, label: "General" },
          { id: planning, label: "Planning" },
        ],
      },
      field("Title", "title", { id: tabs, tab: general }),
      field("Priority", "priority", { id: tabs, tab: planning }, true),
      {
        id: section,
        kind: "section",
        label: "Follow-up",
        validation: { required: false },
        placement: at(2),
        layout: grid(),
        enabledWhen: "record.priority > 0",
      },
      field("Notes", "notes", { id: section }),
    ],
  };
  config.design.navigation[0] = {
    ...config.design.navigation[0],
    label: "Tickets",
    kind: "form",
    targetId: form.id,
    mode: "create",
  };
  await invoke("update_document_config", { windowLabel: "main", config });
}

async function reopen(user: Awaited<ReturnType<typeof renderNewDocument>>, file: string) {
  const archive = join(process.env.IXTABLE_STATE_DIR ?? "", file);
  dialogMock.save.mockResolvedValueOnce(archive);
  await user.click(screen.getByRole("button", { name: "Save project" }));
  await screen.findByText("Saved archive", {}, LONG);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  dialogMock.open.mockResolvedValueOnce(archive);
  await user.click(await screen.findByRole("button", { name: /Open document/i }, LONG));
  await screen.findByText("Saved archive", {}, LONG);
}

it("switches tabs at runtime, flags a tab with errors, and disables a section's controls", async () => {
  const user = await renderNewDocument();
  await seedTicketForm();
  await reopen(user, "form-tabs.ixt");
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  await screen.findByRole("region", { name: "Application page" }, LONG);
  const nav = screen.getByRole("navigation", { name: "Application navigation" });
  await user.click(within(nav).getByRole("button", { name: "Tickets" }));
  const form = await screen.findByRole("form", { name: "New Ticket" }, LONG);

  const tablist = within(form).getByRole("tablist", { name: "Ticket tabs" });
  const generalTab = within(tablist).getByRole("tab", { name: "General" });
  expect(generalTab).toHaveAttribute("aria-selected", "true");
  expect(within(form).getByRole("textbox", { name: "Title" })).toBeInTheDocument();
  expect(within(form).queryByRole("spinbutton", { name: /Priority/ })).toBeNull();

  expect(within(form).getByRole("textbox", { name: "Notes" })).toBeDisabled();

  await user.type(within(form).getByRole("textbox", { name: "Title" }), "Printer jam");
  await user.click(within(form).getByRole("button", { name: "Create" }));
  const planningTab = await within(tablist).findByRole(
    "tab",
    { name: /Planning.*has errors/ },
    LONG,
  );
  expect(within(form).queryByRole("spinbutton", { name: /Priority/ })).toBeNull();

  await user.click(planningTab);
  expect(planningTab).toHaveAttribute("aria-selected", "true");
  expect(within(form).queryByRole("textbox", { name: "Title" })).toBeNull();
  const priority = within(form).getByRole("spinbutton", { name: /Priority/ });
  expect(within(form).getByText("Priority is required.")).toBeInTheDocument();
  await user.type(priority, "2");
  await waitFor(() => expect(within(form).getByRole("textbox", { name: "Notes" })).toBeEnabled());

  await user.keyboard("{Shift>}{Tab}{/Shift}");
  await user.keyboard("{ArrowLeft}");
  await waitFor(() => expect(generalTab).toHaveAttribute("aria-selected", "true"));
  expect(within(form).getByRole("textbox", { name: "Title" })).toHaveValue("Printer jam");
}, 120_000);

it("keeps the stored value of a field disabled after it was typed in", async () => {
  const user = await renderNewDocument();
  await seedTicketForm();
  await reopen(user, "form-disabled.ixt");
  await user.click(screen.getByRole("button", { name: "Runtime" }));
  await screen.findByRole("region", { name: "Application page" }, LONG);
  const nav = screen.getByRole("navigation", { name: "Application navigation" });
  await user.click(within(nav).getByRole("button", { name: "Tickets" }));
  const create = await screen.findByRole("form", { name: "New Ticket" }, LONG);
  const enterPriority = async (form: HTMLElement, value: string) => {
    await user.click(await within(form).findByRole("tab", { name: /Planning/ }, LONG));
    const priority = within(form).getByRole("spinbutton", { name: /Priority/ });
    await user.clear(priority);
    await user.type(priority, value);
  };
  const stored = async () =>
    (await readPage("tickets")).rows.map((row) => row.map((cell) => cell.value ?? null));

  await user.type(within(create).getByRole("textbox", { name: "Title" }), "Jam");
  await enterPriority(create, "2");
  const notes = within(create).getByRole("textbox", { name: "Notes" });
  await waitFor(() => expect(notes).toBeEnabled());
  await user.type(notes, "typed while enabled");
  await enterPriority(create, "0");
  await waitFor(() => expect(notes).toBeDisabled());
  await user.click(within(create).getByRole("button", { name: "Create" }));
  await waitFor(async () => expect(await stored()).toEqual([[1, "Jam", 0, null]]), LONG);

  const detail = await screen.findByRole("form", { name: "Ticket" }, LONG);
  await within(detail).findByDisplayValue("Jam", {}, LONG);
  await user.click(within(detail).getByRole("button", { name: "Edit" }));
  const edit = await screen.findByRole("form", { name: "Edit Ticket" }, LONG);
  await enterPriority(edit, "3");
  const editNotes = within(edit).getByRole("textbox", { name: "Notes" });
  await waitFor(() => expect(editNotes).toBeEnabled());
  await user.type(editNotes, "also typed");
  await enterPriority(edit, "0");
  await waitFor(() => expect(editNotes).toBeDisabled());
  await user.click(within(edit).getByRole("button", { name: "Save" }));
  await screen.findByRole("form", { name: "Ticket" }, LONG);
  expect(await stored()).toEqual([[1, "Jam", 0, null]]);
}, 120_000);
