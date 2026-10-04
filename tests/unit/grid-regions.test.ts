import { describe, expect, it } from "vitest";
import { withLayout } from "../../src/dashboards/model";
import { setLayout } from "../../src/design/operations";
import { newControl, newForm } from "../../src/design/schema";
import { parseTrackLimit, parseTrackSize } from "../../src/design/trackInput";
import { defaultGridLayout } from "../../src/grid/engine";
import { clampRegion, regionNameProblem, remapRegion } from "../../src/grid/regions";
import type { GridLayout, NamedRegion } from "../../src/grid/types";

const region = (name: string, column = 1, columnSpan = 1): NamedRegion => ({
  name,
  column,
  row: 1,
  columnSpan,
  rowSpan: 1,
});

const columns = (count: number): GridLayout => ({
  ...defaultGridLayout(),
  columns: Array.from({ length: count }, () => ({
    kind: "fr" as const,
    value: 1,
    min: null,
    max: null,
  })),
});

describe("region helpers", () => {
  it("clamps regions inside the grid", () => {
    expect(clampRegion(region("a", 5, 9), 4)).toMatchObject({ column: 4, columnSpan: 1 });
    expect(clampRegion({ ...region("a", 0, 0), row: 0, rowSpan: 0 }, 4)).toMatchObject({
      column: 1,
      row: 1,
      columnSpan: 1,
      rowSpan: 1,
    });
  });

  it("follows renames and clears references to removed regions", () => {
    const placement = { column: 2, row: 3, columnSpan: 1, rowSpan: 1, region: "a" };
    expect(remapRegion(placement, [region("b")], { a: "b" }).region).toBe("b");
    expect(remapRegion(placement, [region("a")]).region).toBe("a");
    expect(remapRegion(placement, [])).toEqual({ ...placement, region: null });
  });

  it("rejects empty, padded and duplicate names", () => {
    const regions = [region("a"), region("b")];
    expect(regionNameProblem(regions, 1, "")).toBe("Region name is required.");
    expect(regionNameProblem(regions, 1, " c")).toMatch(/spaces/);
    expect(regionNameProblem(regions, 1, "a")).toMatch(/already named a/);
    expect(regionNameProblem(regions, 1, "b")).toBe("");
  });

  it("parses track sizes and limits", () => {
    expect(parseTrackSize("fr", "")).toMatch(/positive/);
    expect(parseTrackSize("fixed", "0")).toMatch(/positive/);
    expect(parseTrackSize("fixed", "80.4")).toBe(80);
    const track = { kind: "fr" as const, value: 1, min: null, max: 50 };
    expect(parseTrackLimit(track, "min", "90")).toMatch(/Minimum cannot exceed/);
    expect(parseTrackLimit(track, "min", "40")).toBe(40);
    expect(parseTrackLimit(track, "max", "")).toBeNull();
  });
});

describe("setLayout", () => {
  it("renames, clears, and clamps region use for controls on the grid", () => {
    const form = newForm("Orders", { kind: "table", table: "orders" });
    form.layout = { ...columns(4), namedRegions: [region("a", 3, 2), region("b")] };
    const inA = newControl("text", form);
    inA.placement = { ...inA.placement, region: "a" };
    const inB = newControl("text", form);
    inB.placement = { ...inB.placement, region: "b" };
    form.controls.push(inA, inB);
    const next = { ...columns(2), namedRegions: [region("main", 3, 2)] };
    const out = setLayout(form, null, next, { a: "main" });
    expect(out.layout.namedRegions).toEqual([region("main", 2, 1)]);
    expect(out.controls[0].placement.region).toBe("main");
    expect(out.controls[1].placement.region).toBeNull();
  });

  it("does the same for dashboard components", () => {
    const layout = { ...columns(4), namedRegions: [region("a")] };
    const dashboard = {
      layout,
      components: [
        { kind: "kpi", placement: { column: 1, row: 1, columnSpan: 1, rowSpan: 1, region: "a" } },
      ],
    } as unknown as Parameters<typeof withLayout>[0];
    const renamed = withLayout(
      dashboard,
      { ...layout, namedRegions: [region("top")] },
      { a: "top" },
    );
    expect(renamed.components[0].placement.region).toBe("top");
    const removed = withLayout(dashboard, { ...layout, namedRegions: [] });
    expect(removed.components[0].placement.region).toBeNull();
  });
});
