import { join } from "node:path";
import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { dialogMock } from "../setup";
import {
  chooseRelated,
  errorsOf,
  eventually,
  expectAlert,
  LONG,
  openPage,
  runtimeNav,
  runtimePage,
  savedQuery,
  scalar,
  showList,
  sql,
  startFromTemplate,
  type User,
  validateDocument,
  withJourney,
} from "./journey";

const APP = "work-orders";
type Job = { triggerId: string; status: string; attempts: number };
const jobs = () => invoke<Job[]>("list_jobs", { windowLabel: "main", filter: null });
const jobDone = () =>
  eventually(async () =>
    expect((await jobs()).filter((j) => j.triggerId === "wo-trigger-order-created")).toEqual([
      expect.objectContaining({ status: "succeeded", attempts: 1 }),
    ]),
  );

it("Work orders: nested navigation, queries, printable sheet, and operations dashboard", async () => {
  await withJourney(APP, "reads", async (journey) => {
    const user = await journey.step("Create Work orders from the start screen", () =>
      startFromTemplate("Work orders"),
    );
    await journey.step("Validate definitions", async () => {
      journey.check("no error issues", errorsOf(await validateDocument()), []);
    });
    await journey.step("Nested navigation groups open reference tables", async () => {
      const nav = runtimeNav();
      const setup = within(nav).getByText("Setup").closest("details") as HTMLElement;
      const reference = within(setup).getByText("Reference data").closest("details") as HTMLElement;
      expect(within(reference).getByRole("button", { name: "Statuses" })).toBeVisible();
      await user.click(within(reference).getByRole("button", { name: "Priorities" }));
      expect(
        await within(runtimePage()).findByRole("row", { name: "Open low" }, LONG),
      ).toBeVisible();
      journey.check("nesting depth", reference.parentElement?.closest("details") === setup, true);
    });
    await journey.step("Grouped and filtered queries", async () => {
      journey.check("by status", await savedQuery("wo-q-by-status"), [
        ["Open", 3],
        ["In progress", 1],
        ["Done", 1],
        ["Cancelled", 0],
      ]);
      journey.check(
        "open orders by priority",
        (await savedQuery("wo-q-open-orders")).map((r) => [r[0], r[3], r[6]]),
        [
          ["WO-1004", "Urgent", 0],
          ["WO-1001", "High", 50],
          ["WO-1002", "Normal", 0],
          ["WO-1005", "Low", 0],
        ],
      );
      journey.check(
        "priority parameter",
        (await savedQuery("wo-q-open-orders", { priority: "High" })).map((r) => r[0]),
        ["WO-1001"],
      );
    });
    await journey.step(
      "Printable work-order sheet: page 1 of N, headers, footers, totals",
      async () => {
        await openPage(user, "Work order sheet");
        const first = await within(runtimePage()).findByRole(
          "img",
          { name: /^Page 1 of \d+$/ },
          LONG,
        );
        const pages = Number(first.getAttribute("aria-label")?.split(" of ")[1]);
        expect(within(first).getByText("Work order sheet")).toBeInTheDocument();
        expect(within(first).getByText("WO-1001 · Replace pump seal")).toBeInTheDocument();
        expect(within(first).getAllByText("Total hours: 3.5")).toHaveLength(2);
        expect(within(first).getByText(`Page 1 of ${pages}`)).toBeInTheDocument();
        expect(within(first).getByText("Technician signature: ____________")).toBeInTheDocument();
        for (let page = 1; page < pages; page++)
          await user.click(within(runtimePage()).getByRole("button", { name: "Next page" }));
        const last = await within(runtimePage()).findByRole("img", {
          name: `Page ${pages} of ${pages}`,
        });
        journey.check(
          "report total on the last page",
          within(last).queryByText("All work orders: 7 hours") !== null,
          true,
        );
      },
    );
    await journey.step("Operations dashboard with priority filter", async () => {
      await openPage(user, "Operations");
      const page = runtimePage();
      const open = await within(page).findByRole("region", { name: "Open work orders" }, LONG);
      const urgent = within(page).getByRole("region", { name: "Urgent" });
      await within(open).findByText("4", {}, LONG);
      await within(urgent).findByText("1", {}, LONG);
      const priority = within(page).getByRole("combobox", { name: "Priority" });
      await within(priority).findByRole("option", { name: "High" }, LONG);
      await user.selectOptions(priority, "High");
      await within(open).findByText("1", {}, LONG);
      journey.check(
        "urgent within High",
        (await within(urgent).findByText("0", {}, LONG)).textContent,
        "0",
      );
    });
  });
}, 120_000);

async function taskForm(user: User, action: "add" | number) {
  const tasks = await within(runtimePage()).findByRole("region", { name: "Tasks" }, LONG);
  if (action === "add")
    await user.click(await within(tasks).findByRole("button", { name: "Add tasks" }, LONG));
  else
    await user.click(
      await within(tasks).findByRole("button", { name: `Edit tasks row ${action}` }, LONG),
    );
  const name = action === "add" ? "New Task" : "Edit Task";
  return { tasks, form: await within(tasks).findByRole("form", { name }, LONG) };
}

async function addTask(user: User, step: number, description: string, hours: string) {
  const { tasks, form } = await taskForm(user, "add");
  const position = within(form).getByRole("spinbutton", { name: "Step" });
  await user.clear(position);
  await user.type(position, String(step));
  await user.type(within(form).getByRole("textbox", { name: "Description" }), description);
  const hoursInput = within(form).getByRole("spinbutton", { name: "Hours" });
  await user.clear(hoursInput);
  await user.type(hoursInput, hours);
  await user.click(within(form).getByRole("button", { name: "Create" }));
  return { tasks, form };
}

async function markTaskDone(user: User, row: number) {
  const { tasks, form } = await taskForm(user, row);
  const done = await within(form).findByRole("checkbox", { name: "Done" }, LONG);
  await waitFor(() => expect(done).toBeEnabled(), LONG);
  await user.click(done);
  await user.click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() => {
    const alert = within(form).queryByRole("alert");
    if (alert) throw new Error(`Saving the task failed: ${alert.textContent}`);
    expect(within(tasks).queryByRole("form")).toBeNull();
  }, LONG);
}

async function press(user: User, label: string) {
  const form = await within(runtimePage()).findByRole("form", { name: "Work order" }, LONG);
  const edit = await within(form).findByRole("button", { name: "Edit" }, LONG);
  await waitFor(() => expect(edit).toBeEnabled(), LONG);
  const button = await within(form).findByRole("button", { name: label }, LONG);
  await waitFor(() => expect(button).toBeEnabled(), LONG);
  await user.click(button);
  return form;
}

const order = (number: string) =>
  sql(
    `SELECT status_code, progress, started_on IS NOT NULL, completed_on IS NOT NULL FROM work_orders WHERE number = '${number}'`,
  );
const events = (number: string) =>
  sql(
    `SELECT l.event FROM work_order_log l JOIN work_orders w ON w.id = l.work_order_id WHERE w.number = '${number}' ORDER BY l.id`,
  );

it("Work orders: lifecycle with status actions, sync and async triggers, and roles", async () => {
  await withJourney(APP, "lifecycle", async (journey) => {
    const user = await journey.step("Create Work orders from the start screen", () =>
      startFromTemplate("Work orders"),
    );
    const page = runtimePage();

    await journey.step("Create a work order; async trigger logs it in the background", async () => {
      await showList(user, "Work orders");
      await user.click(await within(page).findByRole("button", { name: "New work order" }, LONG));
      const form = await within(page).findByRole("form", { name: "New Work order" }, LONG);
      await user.type(within(form).getByRole("textbox", { name: "Number" }), "1006");
      await user.type(within(form).getByRole("textbox", { name: "Title" }), "Replace HVAC belt");
      await chooseRelated(user, form, "Asset", "Rooftop HVAC unit");
      await chooseRelated(user, form, "Priority", "High");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      expect(await within(form).findByText("Use the form WO-1234.")).toBeInTheDocument();
      const number = within(form).getByRole("textbox", { name: "Number" });
      await user.clear(number);
      await user.type(number, "WO-1006");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      await within(page).findByRole("form", { name: "Work order" }, LONG);
      await jobDone();
      journey.check("new order", await order("WO-1006"), [["open", 0, false, false]]);
      journey.check("audit row written by the job", await events("WO-1006"), [["created"]]);
      await user.click(within(page).getByRole("button", { name: "Back" }));
      await user.click(await within(page).findByRole("row", { name: "Open WO-1006" }, LONG));
      await within(page).findByRole("form", { name: "Work order" }, LONG);
    });

    await journey.step("Start is refused until someone is assigned", async () => {
      const form = await press(user, "Start work");
      await expectAlert(form, "Assign someone before starting this work order.");
      journey.check("still open", (await order("WO-1006"))[0][0], "open");
      await user.click(within(form).getByRole("button", { name: "Edit" }));
      const edit = await within(page).findByRole("form", { name: "Edit Work order" }, LONG);
      await chooseRelated(user, edit, "Assignee", "Tom Chen");
      await user.click(within(edit).getByRole("button", { name: "Save" }));
      await within(page).findByRole("form", { name: "Work order" }, LONG);
    });

    await journey.step("Start work: status transition and log in one transaction", async () => {
      const form = await press(user, "Start work");
      await eventually(async () => expect((await order("WO-1006"))[0][0]).toBe("in_progress"));
      await waitFor(
        () => expect(within(form).getByRole("button", { name: "Complete work" })).toBeEnabled(),
        LONG,
      );
      expect(within(form).getByRole("button", { name: "Start work" })).toBeDisabled();
      journey.check("log", await events("WO-1006"), [["created"], ["started"]]);
    });

    await journey.step(
      "Tasks (one-level master/detail) drive progress via sync triggers",
      async () => {
        const { form } = await addTask(user, 1, "Remove old belt", "1.5");
        expect(within(form).queryByRole("region", { name: "Tasks" })).toBeNull();
        const { tasks } = await addTask(user, 2, "Fit new belt", "2");
        await within(tasks).findByRole("cell", { name: "Fit new belt" }, LONG);
        journey.check("progress after adding tasks", (await order("WO-1006"))[0][1], 0);
        await markTaskDone(user, 1);
        await eventually(async () => expect((await order("WO-1006"))[0][1]).toBe(50));
        journey.check("progress after one of two tasks", (await order("WO-1006"))[0][1], 50);
      },
    );

    await journey.step("Duplicate step number violates the composite unique key", async () => {
      const { form } = await addTask(user, 2, "Duplicate step", "0");
      await expectAlert(form, /Unique constraint failed/);
      await user.click(within(form).getByRole("button", { name: "Cancel" }));
      journey.check(
        "tasks",
        await scalar(
          "SELECT count(*) FROM tasks t JOIN work_orders w ON w.id = t.work_order_id WHERE w.number = 'WO-1006'",
        ),
        2,
      );
    });

    await journey.step("Complete is refused while a task is open", async () => {
      const form = await press(user, "Complete work");
      await expectAlert(form, "Finish every task before completing: 1 still open.");
      journey.check("still in progress", (await order("WO-1006"))[0][0], "in_progress");
    });

    await journey.step("Finish the last task and complete the work order", async () => {
      await markTaskDone(user, 2);
      await eventually(async () => expect((await order("WO-1006"))[0][1]).toBe(100));
      const form = await press(user, "Complete work");
      await eventually(async () => expect((await order("WO-1006"))[0][0]).toBe("done"));
      await waitFor(
        () => expect(within(form).getByRole("button", { name: "Complete work" })).toBeDisabled(),
        LONG,
      );
      journey.check("final state", await order("WO-1006"), [["done", 100, true, true]]);
      journey.check("log", await events("WO-1006"), [["created"], ["started"], ["completed"]]);
    });

    await journey.step("Print sheet opens the report for this work order only", async () => {
      await press(user, "Print sheet");
      const sheet = await within(page).findByRole("img", { name: "Page 1 of 1" }, LONG);
      expect(within(sheet).getByText("WO-1006 · Replace HVAC belt")).toBeInTheDocument();
      expect(within(sheet).queryByText(/^WO-1001/)).toBeNull();
      journey.check(
        "sheet total",
        within(sheet).queryByText("All work orders: 3.5 hours") !== null,
        true,
      );
    });

    await journey.step("Technician role: no setup, no new or deleted work orders", async () => {
      await user.selectOptions(
        screen.getByRole("combobox", { name: "Preview as role" }),
        "Technician",
      );
      await waitFor(() => expect(within(runtimeNav()).queryByText("Setup")).toBeNull(), LONG);
      await showList(user, "Work orders");
      await user.click(await within(page).findByRole("row", { name: "Open WO-1001" }, LONG));
      const form = await within(page).findByRole("form", { name: "Work order" }, LONG);
      expect(await within(form).findByRole("button", { name: "Edit" }, LONG)).toBeVisible();
      journey.check("delete hidden", within(form).queryByRole("button", { name: "Delete" }), null);
      await user.click(within(form).getByRole("button", { name: "Back" }));
      await within(page).findByRole("row", { name: "Open WO-1001" }, LONG);
      journey.check(
        "no create",
        within(page).queryByRole("button", { name: "New work order" }),
        null,
      );
    });
  });
}, 180_000);

const statePath = (name: string) => join(process.env.IXTABLE_STATE_DIR!, name);

async function openSettingsTab(user: User, tab: string) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Application settings" }, LONG);
  await user.click(await screen.findByRole("tab", { name: tab }, LONG));
}

async function exportBundle(user: User, version: string, path: string) {
  await openSettingsTab(user, "Release");
  const input = await screen.findByRole("textbox", { name: "Version" }, LONG);
  await user.clear(input);
  await user.type(input, version);
  dialogMock.save.mockResolvedValueOnce(path);
  await user.click(screen.getByRole("button", { name: "Export runtime bundle…" }));
  const info = await screen.findByRole("region", { name: "Exported bundle" }, LONG);
  await within(info).findByText(`Exported Work orders ${version}`, {}, LONG);
}

async function closeToStart(user: User) {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Close project" }));
  await screen.findByRole("button", { name: /Open runtime bundle/ }, LONG);
}

it("Work orders: v1 bundle, Runtime record, then update to v2 keeps the record and adds due dates", async () => {
  await withJourney(APP, "migration-v1-v2", async (journey) => {
    const user = await journey.step("Create Work orders v1 and save it", async () => {
      const user = await startFromTemplate("Work orders");
      dialogMock.save.mockResolvedValueOnce(statePath("work-orders.ixt"));
      await user.click(screen.getByRole("button", { name: "Save project" }));
      await screen.findByText("Saved archive", {}, LONG);
      return user;
    });
    const v1 = statePath("work-orders-1.0.0.ixtr");
    await journey.step("Export runtime bundle 1.0.0", () => exportBundle(user, "1.0.0", v1));

    await journey.step("Open the bundle and add a Runtime record", async () => {
      await closeToStart(user);
      dialogMock.open.mockResolvedValueOnce(v1);
      await user.click(screen.getByRole("button", { name: /Open runtime bundle/ }));
      const bar = await screen.findByRole("region", { name: "Runtime bundle" }, LONG);
      expect(within(bar).getByText("Version 1.0.0")).toBeInTheDocument();
      await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
      await showList(user, "Work orders");
      const page = runtimePage();
      await user.click(await within(page).findByRole("button", { name: "New work order" }, LONG));
      const form = await within(page).findByRole("form", { name: "New Work order" }, LONG);
      await user.type(within(form).getByRole("textbox", { name: "Number" }), "WO-2001");
      await user.type(within(form).getByRole("textbox", { name: "Title" }), "Runtime-only order");
      await chooseRelated(user, form, "Asset", "Backup generator");
      await user.click(within(form).getByRole("button", { name: "Create" }));
      await within(page).findByRole("form", { name: "Work order" }, LONG);
      await jobDone();
      journey.check("runtime record", await scalar("SELECT count(*) FROM work_orders"), 6);
      expect(within(form).queryByRole("textbox", { name: "Due on" })).toBeNull();
    });

    const v2 = statePath("work-orders-2.0.0.ixtr");
    await journey.step("Upgrade the Studio document to v2 through the YAML tab", async () => {
      await closeToStart(user);
      dialogMock.open.mockResolvedValueOnce(statePath("work-orders.ixt"));
      await user.click(await screen.findByRole("button", { name: /Open document/i }, LONG));
      await screen.findByRole("group", { name: "Document mode" }, LONG);
      const yaml = await invoke<string>("read_template_config", { templateId: "work-orders@2" });
      await openSettingsTab(user, "YAML");
      const editor = await screen.findByRole("textbox", { name: "Configuration YAML" }, LONG);
      await waitFor(
        () => expect((editor as HTMLTextAreaElement).value).toContain("version: 1.0.0"),
        LONG,
      );
      await user.clear(editor);
      editor.focus();
      await user.paste(yaml.replace("activeMode: run", "activeMode: app"));
      await user.click(screen.getByRole("button", { name: "Apply YAML" }));
      await screen.findByText("YAML applied.", {}, LONG);
      await user.click(await screen.findByRole("tab", { name: "Migrations" }, LONG));
      await user.click(await screen.findByRole("button", { name: "Apply pending (1)" }, LONG));
      await screen.findByText(/All migrations succeeded\./, {}, LONG);
      journey.check(
        "Studio data has the new column",
        await sql("SELECT number, due_on FROM work_orders WHERE number = 'WO-1001'"),
        [["WO-1001", null]],
      );
      journey.check("v2 definitions validate", errorsOf(await validateDocument()), []);
    });
    await journey.step("Export runtime bundle 2.0.0", () => exportBundle(user, "2.0.0", v2));

    await journey.step("Update the installation to 2.0.0", async () => {
      await closeToStart(user);
      dialogMock.open.mockResolvedValueOnce(v1);
      await user.click(screen.getByRole("button", { name: /Open runtime bundle/ }));
      const bar = await screen.findByRole("region", { name: "Runtime bundle" }, LONG);
      dialogMock.open.mockResolvedValueOnce(v2);
      await user.click(within(bar).getByRole("button", { name: "Check for update…" }));
      await screen.findByText(/Updated to version 2.0.0. Your records were kept./, {}, LONG);
    });

    await journey.step(
      "The Runtime record is preserved and the new column is present",
      async () => {
        journey.check(
          "record kept, due_on added",
          await sql("SELECT number, title, due_on FROM work_orders WHERE number = 'WO-2001'"),
          [["WO-2001", "Runtime-only order", null]],
        );
        const schema = await invoke<{ columns: Array<{ name: string }> }>("inspect_table", {
          windowLabel: "main",
          table: "work_orders",
        });
        journey.check(
          "due_on column",
          schema.columns.some((c) => c.name === "due_on"),
          true,
        );
        journey.check(
          "migration 002 applied once on the installation",
          await invoke<Array<{ id: string; applied: boolean }>>("migration_status", {
            windowLabel: "main",
          }).then((s) => s.map((m) => [m.id, m.applied])),
          [
            ["wo-001-schema", true],
            ["wo-002-due-dates", true],
            ["work-orders-seed", true],
          ],
        );
        await showList(user, "Work orders");
        const page = runtimePage();
        await user.click(await within(page).findByRole("row", { name: "Open WO-2001" }, LONG));
        const form = await within(page).findByRole("form", { name: "Work order" }, LONG);
        expect(await within(form).findByText("Due on", {}, LONG)).toBeInTheDocument();
      },
    );
  });
}, 240_000);
