import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportData } from "../../src/reports/data";
import { BandCanvas } from "../../src/reports/designer/BandCanvas";
import { bandEntries } from "../../src/reports/model";
import { ReportPreview } from "../../src/reports/ReportPreview";
import { band, baseReport, orders } from "./report-fixtures";

const report = baseReport({
  detail: band(300, [
    { id: "n", kind: "field", expression: "record.customer", x: 0, y: 0, w: 100, h: 14 },
  ]),
});
const load = vi.hoisted(() => vi.fn<() => Promise<ReportData>>());

vi.mock("../../src/lib/config-store", () => ({
  useDocumentConfig: () => ({ config: { reports: [report], savedQueries: [] } }),
}));
vi.mock("../../src/reports/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/reports/data")>()),
  loadReportData: load,
}));

describe("ReportPreview", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    load.mockReset();
  });

  it("shows progress and Cancel only after 2 seconds, then cancels and retries", async () => {
    load.mockReturnValueOnce(new Promise(() => undefined));
    render(<ReportPreview reportId="r1" />);
    expect(screen.getByText("Loading report data…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByRole("progressbar", { name: "Loading report data" })).toBeInTheDocument();
    expect(screen.getByText("2 s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Report loading cancelled.")).toBeInTheDocument();
    load.mockResolvedValueOnce({ rows: orders, tables: {}, assets: {}, truncated: false });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.getByRole("img", { name: "Page 1 of 3" })).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("img", { name: "Page 2 of 3" })).toBeInTheDocument();
    expect(screen.getByText("Cobalt")).toBeInTheDocument();
  });

  it("reports load errors", async () => {
    load.mockRejectedValueOnce(new Error("no such table"));
    await act(async () => {
      render(<ReportPreview reportId="r1" />);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load report data: no such table",
    );
  });

  it("says when the report does not exist", () => {
    render(<ReportPreview reportId="missing" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Report not found.");
  });
});

describe("BandCanvas keyboard editing", () => {
  it("nudges by 1pt, 10pt with Shift, resizes with Alt, clamps to the band, and deletes", () => {
    const onGeometry = vi.fn();
    const onDelete = vi.fn();
    const entries = bandEntries(
      baseReport({
        detail: band(40, [
          { id: "t", kind: "staticText", text: "Hello", x: 5, y: 5, w: 100, h: 20 },
        ]),
      }),
    );
    render(
      <BandCanvas
        bands={entries}
        width={523}
        selectedBand="detail"
        selectedId={null}
        onSelectBand={vi.fn()}
        onSelect={vi.fn()}
        onGeometry={onGeometry}
        onBandHeight={vi.fn()}
        onDelete={onDelete}
      />,
    );
    const item = screen.getByRole("button", { name: "Text Hello" });
    fireEvent.keyDown(item, { key: "ArrowRight" });
    fireEvent.keyDown(item, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(item, { key: "ArrowRight", altKey: true, shiftKey: true });
    fireEvent.keyDown(item, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(item, { key: "Delete" });
    expect(onGeometry.mock.calls).toEqual([
      ["t", { x: 6, y: 5, w: 100, h: 20 }],
      ["t", { x: 5, y: 15, w: 100, h: 20 }],
      ["t", { x: 5, y: 5, w: 110, h: 20 }],
      ["t", { x: 0, y: 5, w: 100, h: 20 }],
    ]);
    expect(onDelete).toHaveBeenCalledWith("t");
    expect(screen.getByRole("button", { name: "Detail · 40 pt" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
