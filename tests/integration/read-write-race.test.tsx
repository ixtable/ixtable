import { within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import {
  chooseRelated,
  eventually,
  LONG,
  runtimePage,
  showList,
  sql,
  startFromTemplate,
} from "./golden/journey";
import { createTable, renderNewDocument, value } from "./helpers";

type Job = { status: string };
type QueryRun = { rows: Array<Array<{ type: string; value?: unknown }>> };
const count = (run: QueryRun) => Number(run.rows[0][0].value);

it("concurrent writes and saved-query reads never fail and reads see committed writes", async () => {
  await renderNewDocument();
  await createTable("race", [
    { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1 },
    { name: "note", declaredType: "TEXT" },
  ]);
  const read = () =>
    invoke<QueryRun>("execute_parameterized_query", {
      windowLabel: "main",
      sql: "SELECT count(*) FROM race WHERE note LIKE $p",
      params: [{ column: "p", value: value("text", "r%") }],
      parameters: null,
      limit: null,
      runId: null,
    });
  for (let round = 0; round < 20; round++) {
    const reads = [read(), read(), read()];
    await invoke("insert_row", {
      windowLabel: "main",
      table: "race",
      values: [{ column: "note", value: value("text", `r${round}-${"x".repeat(4000)}`) }],
    });
    expect(count(await read())).toBe(round + 1);
    for (const run of await Promise.all(reads)) expect(count(run)).toBeGreaterThanOrEqual(round);
  }
}, 120_000);

it("work order details load while the async audit job writes, 20 times in a row", async () => {
  const user = await startFromTemplate("Work orders");
  const page = runtimePage();
  const jobs = () => invoke<Job[]>("list_jobs", { windowLabel: "main", filter: null });
  for (let n = 1; n <= 20; n++) {
    await showList(user, "Work orders");
    await user.click(await within(page).findByRole("button", { name: "New work order" }, LONG));
    const form = await within(page).findByRole("form", { name: "New Work order" }, LONG);
    await user.type(within(form).getByRole("textbox", { name: "Number" }), `WO-${2000 + n}`);
    await user.type(within(form).getByRole("textbox", { name: "Title" }), `Race ${n}`);
    await chooseRelated(user, form, "Asset", "Rooftop HVAC unit");
    await user.click(within(form).getByRole("button", { name: "Create" }));
    const detail = await within(page).findByRole("form", { name: "Work order" }, LONG);
    await eventually(async () =>
      expect((await jobs()).filter((j) => j.status === "succeeded")).toHaveLength(n),
    );
    expect(await within(detail).findByRole("button", { name: "Edit" }, LONG)).toBeEnabled();
    const alerts = within(page)
      .queryAllByRole("alert")
      .map((a) => a.textContent ?? "");
    expect(alerts.filter((a) => /read.?only|locked|busy/i.test(a))).toEqual([]);
  }
  const logged = await sql(
    "SELECT count(*) FROM work_order_log l JOIN work_orders w ON w.id = l.work_order_id WHERE w.number LIKE 'WO-20%' AND l.event = 'created'",
  );
  expect(logged).toEqual([[20]]);
}, 300_000);
