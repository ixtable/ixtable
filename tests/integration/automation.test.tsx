import { screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { insertRecord } from "../../src/lib/records";
import { createTable, insertRow, readPage, renderNewDocument, value } from "./helpers";

const LONG = { timeout: 20_000 };
type User = Awaited<ReturnType<typeof renderNewDocument>>;
type Config = {
  actions: Array<{ id: string; name: string; steps: Array<Record<string, unknown>> }>;
  triggers: Array<Record<string, unknown>>;
};
const readConfig = () => invoke<Config>("read_document_config", { windowLabel: "main" });
const text = (v: string) => value("text", v);

async function setupTables() {
  await createTable("orders", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "status", declaredType: "TEXT" },
  ]);
  await createTable("audit", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "message", declaredType: "TEXT" },
  ]);
}

async function openAutomation(user: User, tab: "Actions" | "Triggers" | "Jobs" = "Actions") {
  await user.click(screen.getByRole("button", { name: "Automation" }));
  await screen.findByRole("heading", { name: "Automation" }, LONG);
  await user.click(screen.getByRole("tab", { name: tab }));
}

async function replace(user: User, input: HTMLElement, next: string) {
  await user.clear(input);
  await user.click(input);
  await user.paste(next);
}

async function defineAction(
  user: User,
  name: string,
  kind: "Create record" | "Update record",
  table: string,
  values: Record<string, string>,
) {
  await user.click(screen.getByRole("button", { name: "New action" }));
  await replace(user, await screen.findByLabelText("Action name"), name);
  await user.selectOptions(screen.getByLabelText("New step kind"), kind);
  await user.click(screen.getByRole("button", { name: "Add step" }));
  const step = await screen.findByRole("group", { name: `Step 1: ${kind}` });
  await user.selectOptions(within(step).getByLabelText("Table"), table);
  const map = within(step).getByRole("group", { name: "Values" });
  for (const [index, [column, expr]] of Object.entries(values).entries()) {
    await user.click(within(map).getByRole("button", { name: "Add column" }));
    await replace(user, within(map).getByLabelText(`Column ${index + 1}`), column);
    await replace(user, within(map).getByLabelText(`${column} expression`), expr);
  }
  await waitFor(async () =>
    expect((await readConfig()).actions.find((a) => a.name === name)?.steps).toHaveLength(1),
  );
}

async function defineTrigger(
  user: User,
  options: {
    name: string;
    action: string;
    mode: "sync" | "async";
    maxAttempts?: string;
    backoff?: string;
  },
) {
  await user.click(screen.getByRole("tab", { name: "Triggers" }));
  await user.click(await screen.findByRole("button", { name: "New trigger" }));
  await replace(user, await screen.findByLabelText("Trigger name"), options.name);
  await user.selectOptions(screen.getByLabelText("Table"), "orders");
  await user.selectOptions(screen.getByLabelText("Event"), "created");
  await user.selectOptions(screen.getByLabelText("Action"), options.action);
  await user.selectOptions(screen.getByLabelText("Run"), options.mode);
  if (options.maxAttempts)
    await replace(user, screen.getByLabelText("Max attempts"), options.maxAttempts);
  if (options.backoff)
    await replace(user, screen.getByLabelText("Retry backoff (ms)"), options.backoff);
  await waitFor(async () =>
    expect((await readConfig()).triggers.find((t) => t.name === options.name)).toMatchObject({
      table: "orders",
      mode: options.mode,
      ...(options.maxAttempts && { maxAttempts: Number(options.maxAttempts) }),
    }),
  );
}

const auditMessages = async () => (await readPage("audit")).rows.map((row) => row[1]?.value).sort();

it("defines a status-transition action in the editor and test-runs it on a sample record", async () => {
  const user = await renderNewDocument();
  await setupTables();
  await insertRow("orders", [
    { column: "id", value: value("integer", 1) },
    { column: "status", value: text("open") },
  ]);
  await openAutomation(user);
  await defineAction(user, "Close order", "Update record", "orders", { status: "'closed'" });
  const step = screen.getByRole("group", { name: "Step 1: Update record" });
  expect(within(step).getByLabelText("Which rows")).toHaveDisplayValue("The current record");
  await replace(user, within(step).getByLabelText("Only when"), "record.status = 'open'");

  await replace(user, screen.getByLabelText("status expression"), "'closed' +");
  expect(await screen.findByText("Unexpected end of expression")).toBeInTheDocument();
  await replace(user, screen.getByLabelText("status expression"), "'closed'");

  await replace(user, screen.getByLabelText("Sample record (JSON)"), '{"id": 1, "status": "open"}');
  await user.click(screen.getByRole("button", { name: "Test run" }));
  const result = await screen.findByRole("status", { name: "Test run result" }, LONG);
  expect(within(result).getByText("Test run succeeded")).toBeInTheDocument();
  expect((await readPage("orders")).rows[0][1]).toEqual(text("closed"));

  await replace(
    user,
    screen.getByLabelText("Sample record (JSON)"),
    '{"id": 1, "status": "closed"}',
  );
  await user.click(screen.getByRole("button", { name: "Test run" }));
  expect(await within(result).findByText("Skipped")).toBeInTheDocument();

  const saved = (await readConfig()).actions[0];
  expect(saved).toMatchObject({ name: "Close order", onError: "stop" });
  expect(saved.steps[0]).toMatchObject({
    kind: "updateRecord",
    table: "orders",
    match: "current",
    values: { status: "'closed'" },
    when: "record.status = 'open'",
  });
});

it("runs a sync created trigger that writes an audit row inside the insert", async () => {
  const user = await renderNewDocument();
  await setupTables();
  await openAutomation(user);
  await defineAction(user, "Audit", "Create record", "audit", {
    message: "'created ' & record.id & ' ' & record.status",
  });
  await defineTrigger(user, { name: "Audit new orders", action: "Audit", mode: "sync" });

  await insertRecord("orders", [
    { column: "id", value: value("integer", 7) },
    { column: "status", value: text("open") },
  ]);
  expect(await auditMessages()).toEqual(["created 7 open"]);
});

it("runs async triggers on the durable queue, with retry after failure and cancel", async () => {
  const user = await renderNewDocument();
  await setupTables();
  await openAutomation(user);
  await defineAction(user, "Audit later", "Create record", "audit", {
    message: "'queued ' & record.id",
  });
  await defineTrigger(user, { name: "Async audit", action: "Audit later", mode: "async" });

  await insertRecord("orders", [
    { column: "id", value: value("integer", 1) },
    { column: "status", value: text("open") },
  ]);
  await waitFor(async () => expect(await auditMessages()).toEqual(["queued 1"]), LONG);

  await user.click(screen.getByRole("tab", { name: "Jobs" }));
  const jobs = await screen.findByRole("table", { name: "Jobs" }, LONG);
  expect(await within(jobs).findByText("succeeded", {}, LONG)).toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "Actions" }));
  await replace(user, await screen.findByLabelText("message expression"), "1 + 'x'");
  await user.click(screen.getByRole("tab", { name: "Triggers" }));
  await replace(user, await screen.findByLabelText("Max attempts"), "1");
  await waitFor(async () => expect((await readConfig()).triggers[0].maxAttempts).toBe(1));
  await insertRecord("orders", [
    { column: "id", value: value("integer", 2) },
    { column: "status", value: text("open") },
  ]);
  await user.click(screen.getByRole("tab", { name: "Jobs" }));
  const jobsTable = () => screen.getByRole("table", { name: "Jobs" });
  const failedCell = await within(
    await screen.findByRole("table", { name: "Jobs" }, LONG),
  ).findByText("failed", {}, LONG);
  const failedRow = failedCell.closest("tr")!;
  expect(within(failedRow).getByText(/Can.t add number and text/)).toBeInTheDocument();
  await user.click(within(failedRow).getByRole("button", { name: /^History of/ }));
  expect(await screen.findByText(/Attempt 1: failed/)).toBeInTheDocument();

  await user.click(screen.getByRole("tab", { name: "Actions" }));
  await replace(user, await screen.findByLabelText("message expression"), "'retried ' & record.id");
  await user.click(screen.getByRole("tab", { name: "Jobs" }));
  const retry = await screen.findByRole("button", { name: /^Retry Async audit job/ }, LONG);
  await user.click(retry);
  await waitFor(async () => expect(await auditMessages()).toEqual(["queued 1", "retried 2"]), LONG);
  await waitFor(
    () => expect(within(jobsTable()).queryByText("failed")).not.toBeInTheDocument(),
    LONG,
  );

  await user.click(screen.getByRole("tab", { name: "Actions" }));
  await replace(user, await screen.findByLabelText("message expression"), "1 + 'x'");
  await user.click(screen.getByRole("tab", { name: "Triggers" }));
  await replace(user, await screen.findByLabelText("Max attempts"), "3");
  await replace(user, screen.getByLabelText("Retry backoff (ms)"), "600000");
  await waitFor(async () => expect((await readConfig()).triggers[0].backoffMs).toBe(600000));
  await insertRecord("orders", [
    { column: "id", value: value("integer", 3) },
    { column: "status", value: text("open") },
  ]);
  await user.click(screen.getByRole("tab", { name: "Jobs" }));
  await user.selectOptions(await screen.findByLabelText("Status"), "queued");
  const cancel = await screen.findByRole("button", { name: /^Cancel Async audit job/ }, LONG);
  await user.click(cancel);
  await user.selectOptions(screen.getByLabelText("Status"), "cancelled");
  await waitFor(() => expect(within(jobsTable()).getByText("cancelled")).toBeInTheDocument(), LONG);
  expect(await auditMessages()).toEqual(["queued 1", "retried 2"]);
});

it("deduplicates jobs by idempotency key", async () => {
  await renderNewDocument();
  const job = { triggerId: "t1", actionId: "a1", payload: {}, idempotencyKey: "same-key" };
  const first = await invoke<{ id: string }>("enqueue_job", { windowLabel: "main", job });
  const second = await invoke<{ id: string }>("enqueue_job", { windowLabel: "main", job });
  expect(second.id).toBe(first.id);
  const listed = await invoke<unknown[]>("list_jobs", { windowLabel: "main", filter: null });
  expect(listed).toHaveLength(1);
});

it("runs rollback-mode actions as one RecordStore transaction", async () => {
  await renderNewDocument();
  await setupTables();
  const { runAction } = await import("../../src/automation/runner");
  const config = await invoke<import("../../src/lib/types").DocumentConfig>(
    "read_document_config",
    { windowLabel: "main" },
  );
  const steps = (message: string) => [
    { id: "s1", kind: "createRecord", table: "audit", values: { message: "'first'" } },
    { id: "s2", kind: "createRecord", table: "audit", values: { id: "1", message } },
  ];
  const ctx = {
    config,
    app: {},
    navigate: () => undefined,
    setState: () => undefined,
    confirm: async () => true,
    notify: () => undefined,
  };
  const failing = await runAction(
    { id: "a", name: "A", onError: "rollback", steps: steps("'duplicate key'") } as never,
    ctx,
  );
  expect(failing.ok).toBe(false);
  expect(failing.error).toMatch(/^Transaction failed: .*no record changes were saved/);
  expect(await auditMessages()).toEqual([]);

  const passing = await runAction(
    { id: "b", name: "B", onError: "rollback", steps: steps("'second'").slice(1) } as never,
    ctx,
  );
  expect(passing).toMatchObject({ ok: true });
  expect(await auditMessages()).toEqual(["second"]);
});
