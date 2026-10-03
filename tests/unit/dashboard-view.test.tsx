import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "../../src/dashboards";
import type { Dashboard } from "../../src/dashboards/types";
import { defaultGridLayout } from "../../src/grid/engine";
import { RuntimeContext, type RuntimeNavigation } from "../../src/runtime/navigation";
import { PageView } from "../../src/runtime/RunMode";

const at = (column: number, columnSpan = 3) => ({
  column,
  row: 1,
  columnSpan,
  rowSpan: 1,
  region: null,
});
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
      options: ["East"],
    },
  ],
  components: [
    {
      id: "k",
      kind: "kpi",
      title: "Open orders",
      placement: at(1),
      queryId: "q1",
      valueField: "n",
    },
    {
      id: "b",
      kind: "button",
      title: "Go",
      label: "Open dashboard",
      placement: at(4),
      actionId: "a1",
    },
    { id: "t", kind: "text", title: "Notes", placement: at(7), text: "First.\n\nSecond." },
  ],
};
const config = {
  dashboards: [dashboard],
  savedQueries: [{ id: "q1", name: "Orders", sql: "", parameters: [] }],
  actions: [
    {
      id: "a1",
      name: "Go",
      onError: "stop",
      steps: [{ id: "s", kind: "openDashboard", dashboardId: "d1" }],
    },
  ],
  reports: [],
  design: { forms: [], navigation: [] },
  roles: [
    { id: "viewer", name: "Viewer", permissions: { navigation: [], objects: [], actions: ["a1"] } },
  ],
};

const api = vi.hoisted(() => ({ runSavedQuery: vi.fn(), cancelQuery: vi.fn() }));
vi.mock("../../src/query/api", () => api);
vi.mock("../../src/lib/config-store", () => ({ useDocumentConfig: () => ({ config }) }));

const result = (n: number) => ({
  columns: ["n"],
  rows: [[{ type: "integer", value: n }]],
  truncated: false,
  rowLimit: 10000,
  elapsedMs: 1,
});

describe("DashboardView", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    api.runSavedQuery.mockReset();
    api.cancelQuery.mockReset();
  });

  it("shows progress and Cancel after 2 seconds, cancels, and refreshes", async () => {
    let reject: (e: unknown) => void = () => undefined;
    api.runSavedQuery.mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    api.cancelQuery.mockImplementation(async () => {
      reject({ code: "CANCELLED", message: "Query cancelled" });
      return 1;
    });
    render(<DashboardView dashboardId="d1" />);
    expect(api.runSavedQuery).toHaveBeenCalledWith(
      "q1",
      { region: null },
      { runId: expect.any(String) },
    );
    expect(screen.queryByRole("button", { name: "Cancel queries" })).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(
      screen.getByRole("progressbar", { name: "Dashboard queries progress" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading dashboard data… 2s (0 of 1 queries done)",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel queries" }));
    });
    expect(api.cancelQuery).toHaveBeenCalledWith(api.runSavedQuery.mock.calls[0][2].runId);
    expect(
      within(screen.getByRole("region", { name: "Open orders" })).getByText("Query cancelled."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();

    api.runSavedQuery.mockResolvedValueOnce(result(42));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(
      within(screen.getByRole("region", { name: "Open orders" })).getByText("42"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Notes" })).getAllByText(/First|Second/),
    ).toHaveLength(2);
  });

  it("passes filter values as parameters", async () => {
    api.runSavedQuery.mockResolvedValue(result(7));
    await act(async () => {
      render(<DashboardView dashboardId="d1" />);
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Region" }), {
        target: { value: "East" },
      });
      vi.advanceTimersByTime(300);
    });
    expect(api.runSavedQuery).toHaveBeenLastCalledWith(
      "q1",
      { region: "East" },
      { runId: expect.any(String) },
    );
  });

  it("enforces the previewed role and routes actions through Runtime navigation", async () => {
    const navigate = vi.fn();
    const runtime: RuntimeNavigation = {
      page: null,
      navigate,
      back: () => undefined,
      canGoBack: false,
      roleId: "viewer",
      setRoleId: () => undefined,
      app: {},
      setAppState: () => undefined,
      notice: null,
      notify: () => undefined,
      attached: true,
    };
    await act(async () => {
      render(
        <RuntimeContext.Provider value={runtime}>
          <DashboardView dashboardId="d1" />
        </RuntimeContext.Provider>,
      );
    });
    expect(api.runSavedQuery).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("You do not have access to this data.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
    });
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ kind: "dashboard", id: "d1" }));
  });

  it("is the Runtime page for dashboard navigation items", async () => {
    api.runSavedQuery.mockResolvedValue(result(5));
    await act(async () => {
      render(<PageView page={{ kind: "dashboard", id: "d1" }} />);
    });
    expect(within(screen.getByRole("region", { name: "Open orders" })).getByText("5")).toBeInTheDocument();
  });

  it("reports a missing dashboard", () => {
    render(<DashboardView dashboardId="nope" />);
    expect(screen.getByRole("alert")).toHaveTextContent("This dashboard does not exist.");
  });
});
