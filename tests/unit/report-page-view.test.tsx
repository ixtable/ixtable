import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { layoutReport, measureText } from "../../src/reports/engine";
import { PageView } from "../../src/reports/PageView";
import { band, baseReport } from "./report-fixtures";

function page(text: string) {
  const doc = layoutReport(
    baseReport({
      detail: band(20, [{ id: "t", kind: "staticText", text, x: 0, y: 0, w: 300, h: 14 }]),
    }),
    [{}],
  );
  render(<PageView doc={doc} page={doc.pages[0]} label="Page" imageUrl={() => undefined} />);
  return screen.getByRole("img", { name: "Page" });
}

it("draws Helvetica-only lines as one text element sized to the engine width", () => {
  const svg = page("Plain text");
  const text = svg.querySelector("text");
  expect(text?.querySelector("tspan")).toBeNull();
  expect(Number(text?.getAttribute("textLength"))).toBeCloseTo(measureText("Plain text", 10), 2);
});

it("draws fallback characters as runs at the engine's offsets and widths", () => {
  const svg = page("Ab Ω漢字");
  const text = svg.querySelector("text");
  expect(text?.getAttribute("textLength")).toBeNull();
  const runs = [...(text?.querySelectorAll("tspan") ?? [])];
  expect(runs.map((r) => r.textContent)).toEqual(["Ab ", "Ω", "漢字"]);
  expect(runs[0].getAttribute("font-family")).toBeNull();
  expect(runs[2].getAttribute("font-family")).toContain("Droid Sans Fallback");
  expect(Number(runs[2].getAttribute("textLength"))).toBe(20);
  const x0 = Number(runs[0].getAttribute("x"));
  expect(Number(runs[2].getAttribute("x")) - x0).toBeCloseTo(measureText("Ab Ω", 10), 6);
});
