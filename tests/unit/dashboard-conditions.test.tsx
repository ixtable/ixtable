import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardView } from "../../src/dashboards";
import type { Dashboard, DashboardComponent } from "../../src/dashboards/types";
import { TableBody } from "../../src/dashboards/widgets";
import { defaultGridLayout } from "../../src/grid/engine";

const at = (column: number) => ({ column, row: 1, columnSpan: 3, rowSpan: 1, region: null });
const dashboard: Dashboard = {
  id: "d1",
  name: "Ops",
  layout: defaultGridLayout(),
  filters: [
    {
      id: "f1",
      name: "Region",
      param: "region",
      logicalType: "text",
      control: "select",
      options: ["East", "West"],
    },
  ],
  components: [
    {
      id: "t",
      kind: "text",
      title: "East notes",
      placement: at(1),
      text: "Only for East.",
      visibleWhen: "params.region = 'East'",
    },
    {
      id: "b",
      kind: "button",
      title: "Go",
      label: "Run",
      placement: at(4),
      actionId: "a1",
      enabledWhen: "isnull(params.region)",
    },
    { id: "n", kind: "text", title: "Always", placement: at(7), text: "Here." },
  ],
};
const broken: Dashboard = {
  ...dashboard,
  id: "d2",
  name: "Broken",
  components: [
    {
      id: "x",
      kind: "text",
      title: "Big region",
      placement: at(1),
      text: "Hidden text",
      visibleWhen: "params.region > 5",
    },
    {
      id: "y",
      kind: "text",
      title: "Odd",
      placement: at(4),
      text: "Odd text",
      enabledWhen: "params.region + 1 > 0",
    },
  ],
};
const config = {
  dashboards: [dashboard, broken],
  savedQueries: [],
  actions: [{ id: "a1", name: "Go", onError: "stop", steps: [] }],
  reports: [],
  design: { forms: [], navigation: [] },
  roles: [],
};
vi.mock("../../src/query/api", () => ({ runSavedQuery: vi.fn(), cancelQuery: vi.fn() }));
vi.mock("../../src/lib/config-store", () => ({ useDocumentConfig: () => ({ config }) }));

describe("dashboard component conditions", () => {
  it("shows a condition that fails to evaluate instead of hiding the component", async () => {
    render(<DashboardView dashboardId="d2" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Region" }), {
      target: { value: "East" },
    });
    const big = await screen.findByRole("region", { name: "Big region" });
    expect(within(big).getByRole("alert")).toHaveTextContent(/^Visible when: /);
    expect(within(big).queryByText("Hidden text")).toBeNull();
    const odd = screen.getByRole("region", { name: "Odd" });
    expect(within(odd).getByRole("alert")).toHaveTextContent(/^Enabled when: /);
    expect(odd).toHaveAttribute("aria-disabled", "true");
    expect(within(odd).queryByText("Not available right now.")).toBeNull();
  });

  it("hides and disables components from params, keeping other placements", async () => {
    render(<DashboardView dashboardId="d1" />);
    expect(screen.queryByRole("region", { name: "East notes" })).toBeNull();
    const button = screen.getByRole("button", { name: "Run" });
    expect(button).toBeEnabled();
    const always = screen.getByRole("region", { name: "Always" });
    const style = always.parentElement?.getAttribute("style");

    fireEvent.change(screen.getByRole("combobox", { name: "Region" }), {
      target: { value: "East" },
    });
    expect(await screen.findByRole("region", { name: "East notes" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeDisabled());
    const go = screen.getByRole("region", { name: "Go" });
    expect(go).toHaveAttribute("aria-disabled", "true");
    expect(within(go).getByText("Not available right now.")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Always" }).parentElement?.getAttribute("style"),
    ).toBe(style);
  });
});

const text = (value: string) => ({ type: "text", value }) as const;
const real = (value: number) => ({ type: "real", value }) as const;
const result = {
  columns: ["region", "total"],
  rows: [
    [text("East"), real(350)],
    [text("North"), real(50)],
    [text("West"), real(400)],
  ],
};

describe("TableBody", () => {
  const table: DashboardComponent = {
    id: "t",
    kind: "table",
    title: "Sales",
    placement: at(1),
    pageSize: 1,
    filter: "record.total >= params.min",
    styles: [
      { id: "s1", when: "value > 380", tone: "positive", column: "total" },
      { id: "s2", when: "true", tone: "muted", column: "total" },
      { id: "s3", when: "record.region = 'West'", tone: "emphasis", column: "region" },
    ],
  };

  it("filters rows before paging and styles cells by column", async () => {
    render(
      <TableBody component={table} result={result as never} scope={{ params: { min: 100 } }} />,
    );
    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "350" })).toHaveClass("tone-muted");
    expect(screen.getByRole("cell", { name: "East" })).not.toHaveClass("tone");
    fireEvent.click(screen.getByRole("button", { name: "Sales next page" }));
    expect(screen.getByRole("cell", { name: "400" })).toHaveClass("tone", "tone-positive");
    expect(screen.getByRole("cell", { name: "West" })).toHaveClass("tone-emphasis");
    expect(screen.queryByRole("cell", { name: "North" })).toBeNull();
  });

  it("shows a filter syntax error instead of rows", () => {
    render(
      <TableBody component={{ ...table, filter: "record.total >" }} result={result as never} />,
    );
    expect(within(screen.getByRole("alert")).getByText(/^Filter:/)).toBeInTheDocument();
  });
});
