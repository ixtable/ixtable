/**
 * Expression diagnostics for the whole document (PRD §17.1). Walks every expression a
 * definition stores and runs `check` with the same names its editor uses, so Problems,
 * bundle export, and cloud publish see exactly what the field editors flag.
 */
import { AUTOMATION_SCOPE_NAMES } from "../automation/fields";
import type { ActionDef, Step } from "../automation/types";
import type { Dashboard } from "../dashboards/types";
import type { DesignControl, DesignForm } from "../design/schema";
import { check } from "../expr";
import type { DocumentConfig, Issue } from "../lib/types";
import { REPORT_SCOPE_NAMES } from "../reports/model";
import type { Band, Report } from "../reports/types";
import { filterNames } from "../runtime/conditions";
import { tableSchema } from "../runtime/data";
import { knownNames } from "../runtime/formState";
import type { RevealTarget } from "./context";

/** An expression that does not check, with the object and field that hold it. */
export type ExpressionIssue = Issue & {
  objectName: string;
  // Field path in the editor's words, e.g. `Control "Total" › Visible when`.
  field: string;
  target: RevealTarget;
};

/** Column names of a table, or undefined when unknown (any `record.x` is then accepted). */
export type ColumnLookup = (table: string | null | undefined) => string[] | undefined;

type Owner = Pick<ExpressionIssue, "objectKind" | "objectId" | "objectName" | "target">;

const DASHBOARD_NAMES = ["params", "app"];
const DASHBOARD_ROW_NAMES = ["record", "params", "app"];
const DASHBOARD_KPI_NAMES = ["rows", "params", "app"];

const present = (src?: string | null): src is string => !!src && src.trim() !== "";

class Collector {
  readonly issues: ExpressionIssue[] = [];
  constructor(readonly columns: ColumnLookup) {}

  add(owner: Owner, field: string, src: string | null | undefined, names: string[]) {
    if (!present(src)) return;
    const diagnostics = check(src, names);
    if (!diagnostics.length) return;
    this.issues.push({
      ...owner,
      severity: "error",
      field,
      message: diagnostics.map((d) => d.message).join("; "),
    });
  }

  map(
    owner: Owner,
    field: string,
    values: Record<string, string> | null | undefined,
    names: string[],
  ) {
    for (const [key, src] of Object.entries(values ?? {}))
      this.add(owner, `${field} ${key}`, src, names);
  }
}

const controlName = (control: DesignControl) =>
  `Control "${control.label || control.binding?.column || control.kind}"`;

function walkForm(c: Collector, form: DesignForm) {
  const base = { objectKind: "form", objectId: form.id, objectName: form.name };
  const owner: Owner = { ...base, target: { mode: "design", objectId: form.id } };
  const table = form.source?.kind === "table" ? form.source.table : null;
  const columns = c.columns(table);
  const names = knownNames(columns);
  if (form.source?.kind === "query")
    c.map(owner, "Query parameter", form.source.params, ["app", "params"]);
  c.add(owner, "Filter", form.filter, filterNames(columns));
  form.rules?.forEach((rule, i) => c.add(owner, `Rule ${i + 1}`, rule.expression, names));
  for (const control of form.controls) {
    const at: Owner = {
      ...base,
      target: { mode: "design", objectId: form.id, elementId: control.id },
    };
    const label = controlName(control);
    c.add(at, `${label} › Visible when`, control.visibleWhen, names);
    c.add(at, `${label} › Enabled when`, control.enabledWhen, names);
    c.add(at, `${label} › Computed value`, control.computed, names);
    c.add(at, `${label} › Default value`, control.defaultValue, names);
    c.add(at, `${label} › Validation`, control.validation?.expression, names);
    if (control.relationship)
      c.add(
        at,
        `${label} › Lookup filter`,
        control.relationship.filter,
        filterNames(c.columns(control.relationship.table)),
      );
    if (control.related)
      c.add(
        at,
        `${label} › Related list filter`,
        control.related.filter,
        filterNames(c.columns(control.related.table)),
      );
    control.styles?.forEach((style, i) =>
      c.add(at, `${label} › Style ${i + 1}`, style.when, names),
    );
  }
}

function walkBand(c: Collector, report: Report, band: Band, bandName: string) {
  for (const component of band.components) {
    const owner: Owner = {
      objectKind: "report",
      objectId: report.id,
      objectName: report.name,
      target: { mode: "reports", objectId: report.id, elementId: component.id },
    };
    const field = `${bandName} › ${component.kind === "table" ? "Table" : component.kind === "field" ? "Field" : "Calculated value"}`;
    if (component.kind === "field" || component.kind === "calculated")
      c.add(owner, field, component.expression, REPORT_SCOPE_NAMES);
    if (component.kind === "table")
      for (const column of component.columns)
        c.add(owner, `${field} column "${column.header}"`, column.expression, REPORT_SCOPE_NAMES);
  }
}

function walkReport(c: Collector, report: Report) {
  const { bands } = report;
  const owner: Owner = {
    objectKind: "report",
    objectId: report.id,
    objectName: report.name,
    target: { mode: "reports", objectId: report.id },
  };
  walkBand(c, report, bands.reportHeader, "Report header");
  walkBand(c, report, bands.pageHeader, "Page header");
  bands.groups.forEach((group, i) => {
    c.add(owner, `Group ${i + 1} › Group by`, group.groupBy, REPORT_SCOPE_NAMES);
    walkBand(c, report, group.header, `Group ${i + 1} header`);
    walkBand(c, report, group.footer, `Group ${i + 1} footer`);
  });
  walkBand(c, report, bands.detail, "Detail");
  walkBand(c, report, bands.pageFooter, "Page footer");
  walkBand(c, report, bands.reportFooter, "Report footer");
}

function walkDashboard(c: Collector, dashboard: Dashboard) {
  for (const component of dashboard.components) {
    const owner: Owner = {
      objectKind: "dashboard",
      objectId: dashboard.id,
      objectName: dashboard.name,
      target: { mode: "dashboards", objectId: dashboard.id, elementId: component.id },
    };
    const label = `Component "${component.title || component.kind}"`;
    c.add(owner, `${label} › Value`, component.expression, DASHBOARD_KPI_NAMES);
    c.add(owner, `${label} › Comparison`, component.comparison?.expression, DASHBOARD_KPI_NAMES);
    c.add(owner, `${label} › Record id`, component.recordId, DASHBOARD_KPI_NAMES);
    c.add(owner, `${label} › Filter`, component.filter, DASHBOARD_ROW_NAMES);
    component.styles?.forEach((style, i) =>
      c.add(owner, `${label} › Style ${i + 1}`, style.when, [...DASHBOARD_ROW_NAMES, "value"]),
    );
    c.add(owner, `${label} › Visible when`, component.visibleWhen, DASHBOARD_NAMES);
    c.add(owner, `${label} › Enabled when`, component.enabledWhen, DASHBOARD_NAMES);
  }
}

function walkSteps(c: Collector, owner: Owner, steps: Step[], path: string) {
  const names = AUTOMATION_SCOPE_NAMES;
  steps.forEach((step, i) => {
    const at = `${path}Step ${i + 1}`;
    c.add(owner, `${at} › ${step.kind === "condition" ? "If" : "Only when"}`, step.when, names);
    switch (step.kind) {
      case "createRecord":
        c.map(owner, `${at} › Value`, step.values, names);
        break;
      case "updateRecord":
        if (step.match !== "current") c.map(owner, `${at} › Match`, step.match, names);
        c.map(owner, `${at} › Value`, step.values, names);
        break;
      case "deleteRecord":
        if (step.match !== "current") c.map(owner, `${at} › Match`, step.match, names);
        break;
      case "runQuery":
      case "openReport":
      case "openDashboard":
        c.map(owner, `${at} › Parameter`, step.params, names);
        break;
      case "navigate":
        c.add(owner, `${at} › Record id`, step.target.recordId, names);
        break;
      case "openForm":
        c.add(owner, `${at} › Record id`, step.recordId, names);
        break;
      case "setState":
        c.add(owner, `${at} › Value`, step.value, names);
        break;
      case "confirm":
      case "fail":
        c.add(owner, `${at} › Message`, step.message, names);
        break;
      case "message":
        c.add(owner, `${at} › Text`, step.text, names);
        break;
      case "condition":
        walkSteps(c, owner, step.then, `${at} › Then › `);
        walkSteps(c, owner, step.else, `${at} › Else › `);
        break;
      default:
        break;
    }
  });
}

function walkAction(c: Collector, action: ActionDef) {
  const owner: Owner = {
    objectKind: "action",
    objectId: action.id,
    objectName: action.name,
    target: { mode: "automation", tab: "actions", objectId: action.id },
  };
  walkSteps(c, owner, action.steps, "");
}

/** Every expression error in `config`, in definition order. */
export function expressionIssues(config: DocumentConfig, columns: ColumnLookup = () => undefined) {
  const c = new Collector(columns);
  for (const form of config.design?.forms ?? []) walkForm(c, form);
  for (const report of config.reports ?? []) walkReport(c, report);
  for (const dashboard of config.dashboards ?? []) walkDashboard(c, dashboard);
  for (const action of config.actions ?? []) walkAction(c, action);
  for (const trigger of config.triggers ?? []) {
    const owner: Owner = {
      objectKind: "trigger",
      objectId: trigger.id,
      objectName: trigger.name,
      target: { mode: "automation", tab: "triggers", objectId: trigger.id },
    };
    c.add(owner, "Condition", trigger.condition, AUTOMATION_SCOPE_NAMES);
    if (trigger.mode === "async")
      c.add(owner, "Idempotency key", trigger.idempotencyKey, AUTOMATION_SCOPE_NAMES);
  }
  return c.issues;
}

/** Tables whose columns limit `record.<field>` in form expressions. */
export function referencedTables(config: DocumentConfig): string[] {
  const tables = new Set<string>();
  for (const form of config.design?.forms ?? []) {
    if (form.source?.kind === "table" && form.source.table) tables.add(form.source.table);
    for (const control of form.controls) {
      if (control.relationship?.table) tables.add(control.relationship.table);
      if (control.related?.table) tables.add(control.related.table);
    }
  }
  return [...tables];
}

/** `expressionIssues` with the current columns of every referenced table. */
export async function loadExpressionIssues(config: DocumentConfig): Promise<ExpressionIssue[]> {
  const entries = await Promise.all(
    referencedTables(config).map((table) =>
      tableSchema(table).then(
        (schema) => [table, schema.columns.map((column) => column.name)] as const,
        () => [table, undefined] as const,
      ),
    ),
  );
  const known = new Map<string, string[] | undefined>(entries);
  return expressionIssues(config, (table) => (table ? known.get(table) : undefined));
}

/** Plain-language blocker shown by bundle export and cloud publish. */
export const expressionBlocker = (count: number) =>
  `${count} expression error${count === 1 ? "" : "s"} must be fixed first (see Settings › Problems)`;
