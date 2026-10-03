import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chart, type ChartSpec } from "../../src/dashboards/charts/Chart";
import { SERIES_COLORS } from "../../src/dashboards/charts/palette";

const rows = [
  { month: "Jan", sales: 10, cost: 6 },
  { month: "Feb", sales: 30, cost: 12 },
  { month: "Mar", sales: 20, cost: 8 },
];
const spec = (patch: Partial<ChartSpec>): ChartSpec => ({
  chartType: "bar",
  x: "month",
  y: ["sales", "cost"],
  ...patch,
});

describe("Chart rendering", () => {
  it.each(["bar", "line", "area"] as const)(
    "%s chart exposes its name, legend and data",
    (chartType) => {
      render(<Chart spec={spec({ chartType })} title="Monthly" rows={rows} />);
      const img = screen.getByRole("img", { name: /^Monthly\./ });
      expect(img.getAttribute("aria-label")).toContain(
        "2 series over 3 month. Values from 6 to 30.",
      );
      const legend = screen.getByRole("list", { name: "Monthly legend" });
      expect(
        within(legend)
          .getAllByRole("listitem")
          .map((li) => li.textContent),
      ).toEqual(["sales", "cost"]);
      const table = screen.getByRole("table", { name: "Monthly data" });
      expect(
        within(table)
          .getAllByRole("row")
          .map((r) => r.textContent),
      ).toEqual(["monthsalescost", "Jan106", "Feb3012", "Mar208"]);
    },
  );

  it("bar marks use the palette in series order with per-mark tooltips", () => {
    const { container } = render(<Chart spec={spec({})} title="Monthly" rows={rows} />);
    const rects = [...container.querySelectorAll("rect")];
    expect(rects).toHaveLength(6);
    expect(rects.map((r) => r.getAttribute("fill"))).toEqual([
      SERIES_COLORS[0],
      SERIES_COLORS[1],
      SERIES_COLORS[0],
      SERIES_COLORS[1],
      SERIES_COLORS[0],
      SERIES_COLORS[1],
    ]);
    expect(rects[2].querySelector("title")?.textContent).toBe("Feb · sales: 30");
  });

  it("pie and donut list shares", () => {
    render(<Chart spec={spec({ chartType: "donut", y: ["sales"] })} title="Mix" rows={rows} />);
    expect(
      screen.getByRole("img", { name: /Donut chart of sales across 3 month\. Total 60\./ }),
    ).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Mix data" });
    expect(
      within(table)
        .getAllByRole("row")
        .map((r) => r.textContent),
    ).toEqual(["monthsalesShare", "Jan1016.7%", "Feb3050%", "Mar2033.3%"]);
    expect(screen.getByRole("list", { name: "Mix legend" }).textContent).toBe(
      "Jan (17%)Feb (50%)Mar (33%)",
    );
  });

  it("scatter plots numeric pairs", () => {
    render(
      <Chart
        spec={spec({ chartType: "scatter", x: "sales", y: ["cost"] })}
        title="Margin"
        rows={rows}
      />,
    );
    expect(
      screen.getByRole("img", { name: /Scatter plot of 3 points: cost against sales/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Margin legend" })).toBeNull();
  });

  it("summary shows the latest value, change and sparkline", async () => {
    render(
      <Chart
        spec={spec({ chartType: "summary", y: ["sales"], format: "#,##0" })}
        title="Sales"
        rows={rows}
      />,
    );
    expect(
      screen.getByRole("img", {
        name: /Latest sales 20, down 10 from the previous value\. 3 values from 10 to 30\./,
      }),
    ).toBeInTheDocument();
    expect(await screen.findByText("▼ 10 vs previous")).toBeInTheDocument();
  });

  it("renders deterministically and handles empty results", async () => {
    const a = render(<Chart spec={spec({ chartType: "line" })} title="Monthly" rows={rows} />)
      .container.innerHTML;
    const b = render(<Chart spec={spec({ chartType: "line" })} title="Monthly" rows={rows} />)
      .container.innerHTML;
    expect(a).toBe(b);
    render(<Chart spec={spec({})} title="Nothing" rows={[]} />);
    expect(await screen.findByText("No data for Nothing.")).toBeInTheDocument();
  });
});
