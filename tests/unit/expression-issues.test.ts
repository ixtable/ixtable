import { describe, expect, it } from "vitest";
import type { ActionDef, Trigger } from "../../src/automation/types";
import { newComponent as newDashboardComponent, newDashboard } from "../../src/dashboards/model";
import { newControl, newForm } from "../../src/design/schema";
import type { DocumentConfig } from "../../src/lib/types";
import { newComponent as newReportComponent, newReport } from "../../src/reports/model";
import {
  expressionBlocker,
  expressionIssues,
  referencedTables,
} from "../../src/shell/expressionIssues";

const base = (change: Partial<DocumentConfig> = {}): DocumentConfig =>
  ({
    version: 1,
    name: "Test",
    activeMode: "design",
    navigationState: null,
    settings: null,
    savedQueries: [],
    design: { forms: [], navigation: [] },
    reports: [],
    dashboards: [],
    actions: [],
    triggers: [],
    migrations: [],
    entities: [],
    roles: [],
    release: { version: "1.0.0", notes: "" },
    ...change,
  }) as unknown as DocumentConfig;

describe("expressionIssues", () => {
  it("finds nothing in a config without broken expressions", () => {
    const form = newForm("Orders", { kind: "table", table: "orders" });
    const control = {
      ...newControl("text", form),
      visibleWhen: "record.total > 0",
      label: "Total",
    };
    const blank = { ...newControl("computed", form), computed: "  " };
    expect(
      expressionIssues(
        base({ design: { forms: [{ ...form, controls: [control, blank] }] } as never }),
      ),
    ).toEqual([]);
  });

  it("flags every form expression field and points at the control", () => {
    const form = newForm("Orders", { kind: "table", table: "orders" });
    const control = {
      ...newControl("text", form),
      label: "Total",
      visibleWhen: "record.total >",
      enabledWhen: "nope(1)",
      computed: "1 +",
      defaultValue: "missing.x",
      validation: { required: false, expression: "len()" },
      styles: [{ id: "s", when: "(", tone: "positive" as const }],
      relationship: {
        table: "customers",
        valueColumn: "id",
        displayColumn: "name",
        filter: "record.bad",
      },
      related: {
        table: "lines",
        foreignKey: "order_id",
        parentColumn: "id",
        columns: [],
        filter: ")",
      },
    };
    const broken = {
      ...form,
      filter: "record.status =",
      rules: [{ id: "r", expression: "and", message: "x" }],
      controls: [control],
    };
    const columns = (table?: string | null) =>
      table === "orders" ? ["total", "status"] : table === "customers" ? ["id", "name"] : undefined;
    const issues = expressionIssues(base({ design: { forms: [broken] } as never }), columns);
    expect(issues.map((i) => i.field)).toEqual([
      "Filter",
      "Rule 1",
      'Control "Total" › Visible when',
      'Control "Total" › Enabled when',
      'Control "Total" › Computed value',
      'Control "Total" › Default value',
      'Control "Total" › Validation',
      'Control "Total" › Lookup filter',
      'Control "Total" › Related list filter',
      'Control "Total" › Style 1',
    ]);
    expect(issues.every((i) => i.severity === "error" && i.objectKind === "form")).toBe(true);
    expect(issues[0]?.target).toEqual({ mode: "design", objectId: form.id });
    expect(issues[2]).toMatchObject({
      objectId: form.id,
      objectName: "Orders",
      target: { mode: "design", objectId: form.id, elementId: control.id },
    });
    expect(issues.find((i) => i.field.endsWith("Enabled when"))?.message).toBe(
      "Unknown function 'nope'",
    );
    expect(issues.find((i) => i.field.endsWith("Lookup filter"))?.message).toBe(
      "Unknown field 'record.bad'",
    );
  });

  it("uses the form's columns for record fields, like the designer", () => {
    const form = newForm("Orders", { kind: "table", table: "orders" });
    const control = { ...newControl("text", form), computed: "record.renamed * 2" };
    const config = base({ design: { forms: [{ ...form, controls: [control] }] } as never });
    expect(expressionIssues(config)).toEqual([]);
    const [issue] = expressionIssues(config, () => ["total"]);
    expect(issue?.message).toBe("Unknown field 'record.renamed'");
  });

  it("checks query-source parameters with app and params only", () => {
    const form = newForm("Recent", {
      kind: "query",
      queryId: "q",
      params: { since: "record.x", n: "params.n" },
    });
    const [issue, ...rest] = expressionIssues(base({ design: { forms: [form] } as never }));
    expect(rest).toEqual([]);
    expect(issue).toMatchObject({
      field: "Query parameter since",
      message: "Unknown name 'record'",
    });
  });

  it("walks report bands, groups and table columns", () => {
    const report = newReport("Sales");
    const field = { ...newReportComponent("field", 500), expression: "record.amount +" };
    const table = {
      ...newReportComponent("table", 500),
      columns: [{ id: "c", header: "Qty", expression: "sum(", width: 40 }],
    };
    const group = {
      id: "g",
      groupBy: "unknown.region",
      header: { height: 10, keepTogether: false, components: [] },
      footer: { height: 10, keepTogether: false, components: [table] },
    };
    report.bands.detail.components = [field];
    report.bands.groups = [group];
    const issues = expressionIssues(base({ reports: [report] }));
    expect(issues.map((i) => i.field)).toEqual([
      "Group 1 › Group by",
      'Group 1 footer › Table column "Qty"',
      "Detail › Field",
    ]);
    expect(issues[1]?.target).toEqual({
      mode: "reports",
      objectId: report.id,
      elementId: table.id,
    });
    expect(issues[0]?.target).toEqual({ mode: "reports", objectId: report.id });
  });

  it("walks dashboard components with their scopes", () => {
    const dashboard = newDashboard("Ops");
    const kpi = {
      ...newDashboardComponent("kpi", dashboard),
      title: "Revenue",
      expression: "sum(rows.amount)",
      comparison: { label: "vs", expression: "record.x" },
      visibleWhen: "params.region = 'EU'",
      enabledWhen: "rows",
    };
    const table = {
      ...newDashboardComponent("table", dashboard),
      title: "Orders",
      filter: "record.total > params.min",
      styles: [{ id: "s", when: "value >", tone: "negative" as const, column: "total" }],
    };
    dashboard.components = [kpi, table];
    const issues = expressionIssues(base({ dashboards: [dashboard] }));
    expect(issues.map((i) => [i.field, i.message])).toEqual([
      ['Component "Revenue" › Comparison', "Unknown name 'record'"],
      ['Component "Revenue" › Enabled when', "Unknown name 'rows'"],
      ['Component "Orders" › Style 1', expect.any(String)],
    ]);
    expect(issues[2]?.target).toEqual({
      mode: "dashboards",
      objectId: dashboard.id,
      elementId: table.id,
    });
  });

  it("walks action steps, nested branches and triggers", () => {
    const action: ActionDef = {
      id: "a1",
      name: "Close order",
      onError: "stop",
      steps: [
        {
          id: "s1",
          kind: "updateRecord",
          table: "orders",
          match: "current",
          values: { status: "'closed" },
        },
        {
          id: "s2",
          kind: "condition",
          when: "record.total > 100",
          then: [{ id: "s3", kind: "message", text: "bogus(1)" }],
          else: [{ id: "s4", kind: "setState", scope: "app", key: "k", value: "1", when: "x.y" }],
        },
        { id: "s5", kind: "runQuery", queryId: "q", params: { id: "record.id" }, storeAs: "r" },
      ],
    };
    const trigger: Trigger = {
      id: "t1",
      name: "On create",
      table: "orders",
      event: "created",
      condition: "record.total >",
      actionId: "a1",
      mode: "async",
      enabled: true,
      idempotencyKey: "trigger.id & record.id",
      maxAttempts: 3,
      backoffMs: 100,
    } as Trigger;
    const issues = expressionIssues(base({ actions: [action], triggers: [trigger] }));
    expect(issues.map((i) => i.field)).toEqual([
      "Step 1 › Value status",
      "Step 2 › Then › Step 1 › Text",
      "Step 2 › Else › Step 1 › Only when",
      "Condition",
    ]);
    expect(issues[0]?.target).toEqual({ mode: "automation", tab: "actions", objectId: "a1" });
    expect(issues[3]?.target).toEqual({ mode: "automation", tab: "triggers", objectId: "t1" });
  });

  it("ignores the idempotency key of a sync trigger, as the editor hides it", () => {
    const trigger = {
      id: "t",
      name: "Sync",
      table: "t",
      event: "created",
      actionId: "a",
      mode: "sync",
      enabled: true,
      idempotencyKey: "(",
      maxAttempts: 1,
      backoffMs: 0,
    } as Trigger;
    expect(expressionIssues(base({ triggers: [trigger] }))).toEqual([]);
  });
});

describe("helpers", () => {
  it("lists the tables whose columns form expressions read", () => {
    const form = newForm("Orders", { kind: "table", table: "orders" });
    const lookup = {
      ...newControl("relationship", form),
      relationship: { table: "customers", valueColumn: "id", displayColumn: "name" },
    };
    const related = {
      ...newControl("relatedList", form),
      related: { table: "lines", foreignKey: "o", parentColumn: "id", columns: [] },
    };
    const config = base({ design: { forms: [{ ...form, controls: [lookup, related] }] } as never });
    expect(referencedTables(config)).toEqual(["orders", "customers", "lines"]);
  });

  it("phrases the distribution blocker", () => {
    expect(expressionBlocker(1)).toBe(
      "1 expression error must be fixed first (see Settings › Problems)",
    );
    expect(expressionBlocker(3)).toMatch(/^3 expression errors/);
  });
});
