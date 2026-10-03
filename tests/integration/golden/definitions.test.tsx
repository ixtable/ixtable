import { screen, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { expect, it } from "vitest";
import { check } from "../../../src/expr";
import { asTauriError } from "../../../src/lib/api";
import type { DocumentConfig } from "../../../src/lib/types";
import { errorsOf, savedQuery, startFromTemplate, validateDocument, withJourney } from "./journey";

type Template = { id: string; name: string; description: string; version: string };

const FORM_ROOTS = ["record", "form", "app", "value"];
const REPORT_ROOTS = ["record", "rows", "params", "page", "pages"];
const DASHBOARD_ROOTS = ["rows", "params"];
const ACTION_ROOTS = ["record", "old", "form", "app", "params", "results", "steps"];
const TRIGGER_ROOTS = ["record", "old", "app", "trigger"];

type Found = { where: string; source: string; roots: string[] };

function expressions(config: DocumentConfig): Found[] {
  const out: Found[] = [];
  const add = (where: string, source: unknown, roots: string[]) => {
    if (typeof source === "string" && source.trim()) out.push({ where, source, roots });
  };
  for (const form of config.design.forms) {
    for (const rule of form.rules ?? []) add(`form ${form.id} rule`, rule.expression, FORM_ROOTS);
    for (const c of form.controls) {
      const where = `form ${form.id} control ${c.id}`;
      for (const key of ["visibleWhen", "enabledWhen", "computed", "defaultValue"] as const)
        add(`${where} ${key}`, c[key], FORM_ROOTS);
      add(`${where} validation`, c.validation?.expression, FORM_ROOTS);
    }
  }
  for (const report of config.reports) {
    const bands = report.bands;
    const all = [
      bands.reportHeader,
      bands.pageHeader,
      bands.detail,
      bands.pageFooter,
      bands.reportFooter,
      ...bands.groups.flatMap((g) => [g.header, g.footer]),
    ];
    for (const g of bands.groups) add(`report ${report.id} group`, g.groupBy, REPORT_ROOTS);
    for (const band of all)
      for (const c of band.components) {
        if ("expression" in c) add(`report ${report.id} ${c.id}`, c.expression, REPORT_ROOTS);
        if (c.kind === "table")
          for (const col of c.columns)
            add(`report ${report.id} ${col.id}`, col.expression, REPORT_ROOTS);
      }
  }
  for (const dashboard of config.dashboards ?? [])
    for (const c of dashboard.components ?? []) {
      add(`dashboard ${dashboard.id} ${c.id}`, c.expression, DASHBOARD_ROOTS);
      add(
        `dashboard ${dashboard.id} ${c.id} comparison`,
        c.comparison?.expression,
        DASHBOARD_ROOTS,
      );
    }
  const steps = (actionId: string, list: Array<Record<string, unknown>>) => {
    for (const step of list) {
      const where = `action ${actionId} step ${String(step.id)}`;
      add(`${where} when`, step.when, ACTION_ROOTS);
      for (const key of ["text", "message", "value", "recordId"])
        add(where, step[key], ACTION_ROOTS);
      for (const key of ["values", "params", "match"]) {
        const map = step[key];
        if (map && typeof map === "object")
          for (const [column, source] of Object.entries(map))
            add(`${where} ${column}`, source, ACTION_ROOTS);
      }
      for (const branch of ["then", "else"])
        if (Array.isArray(step[branch]))
          steps(actionId, step[branch] as Array<Record<string, unknown>>);
    }
  };
  for (const action of config.actions)
    steps(action.id, action.steps as unknown as Array<Record<string, unknown>>);
  for (const trigger of config.triggers) {
    add(`trigger ${trigger.id} condition`, trigger.condition, TRIGGER_ROOTS);
    add(`trigger ${trigger.id} key`, trigger.idempotencyKey, TRIGGER_ROOTS);
  }
  return out;
}

it("lists the three golden applications on the start screen", async () => {
  await withJourney("templates", "start-screen", async (journey) => {
    const listed = await journey.step("List templates", () =>
      invoke<Template[]>("list_templates", {}),
    );
    journey.check(
      "templates",
      listed.map((t) => [t.id, t.name, t.version]),
      [
        ["crm", "CRM", "1.0.0"],
        ["inventory", "Inventory", "1.0.0"],
        ["work-orders", "Work orders", "1.0.0"],
      ],
    );
    await journey.step("Create Inventory from the start screen", async () => {
      await startFromTemplate("Inventory");
      const state = await invoke<{ name: string; path: string | null; activeMode: string }>(
        "document_state",
        { windowLabel: "main" },
      );
      journey.check(
        "new untitled document",
        [state.name, state.path, state.activeMode],
        ["Inventory", null, "run"],
      );
      const modes = screen.getByRole("group", { name: "Document mode" });
      expect(within(modes).getByRole("button", { name: "Runtime" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });
});

for (const id of ["crm", "inventory", "work-orders"]) {
  it(`${id}: definitions validate, expressions parse, and every saved query runs`, async () => {
    await withJourney(id, "definitions", async (journey) => {
      await journey.step("Create from template", () =>
        invoke("create_from_template", { windowLabel: "main", templateId: id }),
      );
      const config = await invoke<DocumentConfig>("read_document_config", { windowLabel: "main" });
      await journey.step("Validate document", async () => {
        journey.check("no error issues", errorsOf(await validateDocument()), []);
      });
      await journey.step("Parse every expression", async () => {
        const found = expressions(config);
        expect(found.length).toBeGreaterThan(10);
        const problems = found.flatMap((e) =>
          check(e.source, e.roots).map((d) => `${e.where}: ${e.source}: ${d.message}`),
        );
        journey.check(`${found.length} expressions`, problems, []);
      });
      await journey.step("Run every saved query", async () => {
        const failures: string[] = [];
        for (const query of config.savedQueries) {
          const required = Object.fromEntries(
            (query.parameters ?? []).filter((p) => p.required).map((p) => [p.name, 1]),
          );
          await savedQuery(query.name, required).catch((e: unknown) =>
            failures.push(`${query.name}: ${String((e as Error).message ?? e)}`),
          );
        }
        journey.check(`${config.savedQueries.length} queries`, failures, []);
      });
    });
  }, 60_000);
}

it("rejects unknown templates without leaving a document open", async () => {
  const code = await invoke("create_from_template", { windowLabel: "main", templateId: "missing" })
    .then(() => "OK")
    .catch((reason: unknown) => asTauriError(reason).code);
  expect(code).toBe("NOT_FOUND");
  const state = await invoke("document_state", { windowLabel: "main" })
    .then(() => "OPEN")
    .catch((reason: unknown) => asTauriError(reason).code);
  expect(state).toBe("NO_DOCUMENT");
});
