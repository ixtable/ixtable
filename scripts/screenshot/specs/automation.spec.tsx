import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { captureDocument } from "../capture";
import { LONG, openMode, startFromTemplate, type User } from "./fixtures";

const runtimePage = () => screen.getByRole("region", { name: "Application page" });
const runtimeNav = () => screen.getByRole("navigation", { name: "Application navigation" });

async function chooseRelated(user: User, form: HTMLElement, label: string, option: string) {
  const select = await within(form).findByRole("combobox", { name: label }, LONG);
  await within(select).findByRole("option", { name: option }, LONG);
  await user.selectOptions(select, option);
}

/** Relationship fields show the related record's display value once its lookup returns. */
async function relatedLabels(label: string, value: string) {
  await waitFor(
    () =>
      expect(
        within(screen.getByRole("form", { name: "Work order" })).getByRole("textbox", {
          name: label,
        }),
      ).toHaveValue(value),
    LONG,
  );
}

const statusOf = async (number: string) =>
  (
    await invoke<{ rows: Array<Array<{ value?: unknown }>> }>("execute_read_query", {
      windowLabel: "main",
      sql: `SELECT status_code FROM work_orders WHERE number = '${number}'`,
    })
  ).rows[0]?.[0]?.value;

it("runs action buttons, sync and async triggers, and role previews in the Work orders app", async () => {
  const user = await startFromTemplate("Work orders");
  const page = runtimePage();

  // Create a work order: the async "log in the background" trigger queues a job.
  await user.click(within(runtimeNav()).getByRole("button", { name: "Work orders" }));
  await user.click(await within(page).findByRole("button", { name: "New work order" }, LONG));
  const create = await within(page).findByRole("form", { name: "New Work order" }, LONG);
  await user.type(within(create).getByRole("textbox", { name: "Number" }), "WO-1006");
  await user.type(within(create).getByRole("textbox", { name: "Title" }), "Replace HVAC belt");
  await chooseRelated(user, create, "Asset", "Rooftop HVAC unit");
  await chooseRelated(user, create, "Priority", "High");
  await user.click(within(create).getByRole("button", { name: "Create" }));
  let form = await within(page).findByRole("form", { name: "Work order" }, LONG);

  // The Start work action refuses an unassigned order with its own message.
  await user.click(await within(form).findByRole("button", { name: "Start work" }, LONG));
  await waitFor(() => {
    const alerts = within(form).queryAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join("\n")).toMatch(
      "Assign someone before starting this work order.",
    );
  }, LONG);
  await relatedLabels("Asset", "Rooftop HVAC unit");
  await relatedLabels("Status", "Open");
  await captureDocument(document, {
    name: "automation-01-action-refused",
    expectations: [
      "The Work order detail shows Start work, Complete work, and Print sheet action buttons.",
      "The action's condition message explains that someone must be assigned first.",
      "The Tasks related list sits below the work order fields.",
    ],
  });

  await user.click(within(form).getByRole("button", { name: "Edit" }));
  const edit = await within(page).findByRole("form", { name: "Edit Work order" }, LONG);
  await chooseRelated(user, edit, "Assignee", "Tom Chen");
  await user.click(within(edit).getByRole("button", { name: "Save" }));
  form = await within(page).findByRole("form", { name: "Work order" }, LONG);
  await user.click(await within(form).findByRole("button", { name: "Start work" }, LONG));
  await waitFor(async () => expect(await statusOf("WO-1006")).toBe("in_progress"), LONG);
  await waitFor(
    () => expect(within(form).getByRole("button", { name: "Complete work" })).toBeEnabled(),
    LONG,
  );
  await relatedLabels("Asset", "Rooftop HVAC unit");
  await relatedLabels("Assignee", "Tom Chen");
  await relatedLabels("Status", "In progress");
  // The action's message shows once, inside the form; one back link leads to the list.
  expect(screen.getAllByText("Work order started.")).toHaveLength(1);
  expect(within(form).getByRole("status")).toHaveTextContent("Work order started.");
  expect(
    within(page)
      .getAllByRole("button", { name: /back|previous page/i })
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual(["Back to Work orders"]);
  await captureDocument(document, {
    name: "automation-02-action-applied",
    expectations: [
      "After Start work the status reads In progress and Start work is disabled.",
      "'Work order started.' appears once, inside the Work order card; no page-level copy.",
      "A single '← Work orders' back link sits above the card; the header has only Edit and Delete.",
    ],
  });

  // Studio: the action, trigger, and job definitions behind the buttons.
  await openMode(user, "Automation");
  await screen.findByRole("heading", { name: "Automation" }, LONG);
  await user.click(screen.getByRole("tab", { name: "Actions" }));
  await user.click(await screen.findByRole("button", { name: /^Start work/ }, LONG));
  await screen.findByRole("group", { name: /^Step 1:/ }, LONG);
  await captureDocument(document, {
    name: "automation-03-action-editor",
    expectations: [
      "The Actions tab lists the template's actions with Start work selected.",
      "Its steps show the condition, the status update, and the log insert with expressions.",
    ],
  });
  await user.click(screen.getByRole("tab", { name: "Triggers" }));
  await user.click(
    await screen.findByRole("button", { name: /^Log new work orders in the background/ }, LONG),
  );
  expect(await screen.findByLabelText("Run")).toHaveValue("async");
  await captureDocument(document, {
    name: "automation-04-triggers",
    expectations: [
      "The Triggers tab lists sync (progress) and async (logging) triggers.",
      "The selected trigger runs async with retry attempts and backoff fields.",
    ],
  });
  await user.click(screen.getByRole("tab", { name: "Jobs" }));
  const jobs = await screen.findByRole("table", { name: "Jobs" }, LONG);
  expect(await within(jobs).findByText("succeeded", {}, LONG)).toBeInTheDocument();
  await captureDocument(document, {
    name: "automation-05-jobs",
    expectations: [
      "The Jobs table shows the background logging job for WO-1006 as succeeded after 1 attempt.",
      "Each row offers history, and the status filter sits above the table.",
    ],
  });

  // Roles: preview the Technician role in the Runtime.
  await openMode(user, "Settings");
  await user.click(await screen.findByRole("tab", { name: "Roles" }, LONG));
  await user.click(await screen.findByRole("button", { name: "Technician" }, LONG));
  await captureDocument(document, {
    name: "roles-01-editor",
    expectations: [
      "The Roles tab explains roles are not a database security boundary.",
      "The Technician role shows per-form permissions and navigation visibility checkboxes.",
    ],
  });
  await openMode(user, "Runtime");
  await user.selectOptions(
    await screen.findByRole("combobox", { name: "Preview as role" }, LONG),
    "Technician",
  );
  await waitFor(() => expect(within(runtimeNav()).queryByText("Setup")).toBeNull(), LONG);
  await user.click(within(runtimeNav()).getByRole("button", { name: "Work orders" }));
  await user.click(await within(runtimePage()).findByRole("row", { name: "Open WO-1001" }, LONG));
  const technician = await within(runtimePage()).findByRole("form", { name: "Work order" }, LONG);
  await waitFor(
    () =>
      expect(within(technician).getByRole("textbox", { name: "Number" })).toHaveValue("WO-1001"),
    LONG,
  );
  await relatedLabels("Status", "In progress");
  await waitFor(
    () => expect(within(technician).getByRole("button", { name: "Edit" })).toBeEnabled(),
    LONG,
  );
  expect(within(technician).queryByRole("button", { name: "Delete" })).toBeNull();
  // Task "Done" (INTEGER 0/1 behind a boolean control) reads Yes/No, not 1/0.
  const tasks = within(technician).getByRole("region", { name: "Tasks" });
  expect(await within(tasks).findAllByRole("cell", { name: "Yes" }, LONG)).toHaveLength(2);
  expect(within(tasks).getAllByRole("cell", { name: "No" })).toHaveLength(2);
  await captureDocument(document, {
    name: "roles-02-runtime-preview",
    expectations: [
      "Preview as role reads Technician and the Setup navigation group is hidden.",
      "The work order offers Edit but no Delete button.",
      "The Tasks Done column shows checkmarks for done tasks and dashes for open ones, not 1/0.",
    ],
  });
});

it("switches a trigger to run as the signed-in user and warns on roles that cannot run it", async () => {
  const user = await startFromTemplate("Work orders");
  await openMode(user, "Automation");
  await screen.findByRole("heading", { name: "Automation" }, LONG);
  await user.click(screen.getByRole("tab", { name: "Triggers" }));
  await user.click(
    await screen.findByRole("button", { name: /^Log new work orders in the background/ }, LONG),
  );
  const runAs = await screen.findByLabelText("Run as");
  expect(runAs).toHaveValue("app");
  expect(
    within(runAs)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["App — the trigger's own steps", "Signed-in user's role"]);
  await user.selectOptions(runAs, "user");
  await waitFor(() => expect(screen.getByLabelText("Run as")).toHaveValue("user"), LONG);
  await captureDocument(document, {
    name: "automation-06-run-as-user",
    expectations: [
      "The selected background logging trigger shows a Run as select reading 'Signed-in user's role'.",
      "The help text explains the difference between running as the app and as the signed-in user.",
    ],
  });

  await openMode(user, "Settings");
  await user.click(await screen.findByRole("tab", { name: "Roles" }, LONG));
  await user.click(await screen.findByRole("button", { name: "Technician" }, LONG));
  const warning = await screen.findByText(
    /Trigger "Log new work orders in the background" runs as the signed-in user/,
    {},
    LONG,
  );
  expect(warning).toHaveTextContent("Saves that fire it will be refused for this role.");
  expect(warning).toHaveTextContent('execute action "Log new work order"');
  await captureDocument(document, {
    name: "roles-03-user-trigger-warning",
    expectations: [
      "The Technician role shows a warning that the background logging trigger runs as the signed-in user.",
      "The warning names the permissions the role is missing by object name (not uuid) and says its saves will be refused.",
    ],
  });
});
