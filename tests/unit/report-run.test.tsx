import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComponentProperties } from "../../src/reports/designer/ComponentProperties";
import { ReportRun } from "../../src/reports/ReportRun";
import type { ReportComponent } from "../../src/reports/types";
import { baseReport } from "./report-fixtures";

const report = { ...baseReport(), datasetQueryId: "q" };
const query = {
  id: "q",
  name: "Q",
  sql: "SELECT 1",
  parameters: [
    { name: "region", logicalType: "text", required: true },
    { name: "note", logicalType: "text" },
  ],
};

vi.mock("../../src/lib/config-store", () => ({
  useDocumentConfig: () => ({ config: { reports: [report], savedQueries: [query] } }),
}));
vi.mock("../../src/reports/ReportPreview", () => ({
  ReportPreview: ({ params }: { params?: Record<string, unknown> }) => (
    <p>preview {JSON.stringify(params)}</p>
  ),
}));

describe("ReportRun", () => {
  it("runs without a prompt when every parameter is given", async () => {
    render(<ReportRun reportId="r1" params={{ region: "West", note: null }} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await screen.findByText('preview {"region":"West","note":null}');
  });

  it("prompts when a required parameter is passed as null", () => {
    render(<ReportRun reportId="r1" params={{ region: null, note: "x" }} />);
    expect(screen.getByRole("dialog", { name: "Sales parameters" })).toBeInTheDocument();
    expect(screen.queryByText(/^preview/)).toBeNull();
  });
});

describe("ComponentProperties", () => {
  const text: ReportComponent = {
    id: "t",
    kind: "staticText",
    text: "Hi",
    x: 0,
    y: 0,
    w: 100,
    h: 14,
  };
  const props = { columns: [], queries: [], assets: [], onChange: () => {}, onDelete: () => {} };

  it("offers Can grow on body bands only", () => {
    const { rerender } = render(<ComponentProperties component={text} {...props} />);
    expect(screen.getByRole("checkbox", { name: "Can grow" })).toBeInTheDocument();
    rerender(<ComponentProperties component={text} pageBand {...props} />);
    expect(screen.queryByRole("checkbox", { name: "Can grow" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Bold" })).toBeInTheDocument();
  });
});
