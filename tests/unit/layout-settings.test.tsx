import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutSettings } from "../../src/design/LayoutSettings";
import { RegionPicker } from "../../src/design/RegionEditor";
import { defaultGridLayout } from "../../src/grid/engine";
import type { GridItemRef, GridLayout, Placement } from "../../src/grid/types";

function Harness({
  initial,
  items,
  onChange,
}: {
  initial: GridLayout;
  items?: (GridItemRef & { label?: string })[];
  onChange?: (layout: GridLayout, renames?: Record<string, string>) => void;
}) {
  const [layout, setLayout] = useState(initial);
  return (
    <LayoutSettings
      layout={layout}
      items={items}
      onChange={(next, renames) => {
        setLayout(next);
        onChange?.(next, renames);
      }}
    />
  );
}

const small = (): GridLayout => ({
  ...defaultGridLayout(),
  columns: Array.from({ length: 3 }, () => ({
    kind: "fr" as const,
    value: 1,
    min: null,
    max: null,
  })),
});

const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0] as GridLayout;

describe("LayoutSettings", () => {
  let user: ReturnType<typeof userEvent.setup>;
  beforeEach(() => {
    user = userEvent.setup();
  });

  it("edits column and row tracks, keeping authored tracks when the count changes", async () => {
    const onChange = vi.fn();
    render(<Harness initial={small()} onChange={onChange} />);
    await user.selectOptions(screen.getByLabelText("Column 1 size kind"), "fixed");
    expect(last(onChange).columns[0]).toEqual({ kind: "fixed", value: 120, min: null, max: null });
    await user.type(screen.getByLabelText("Column 2 minimum pixels"), "80");
    await user.tab();
    expect(last(onChange).columns[1].min).toBe(80);
    await user.selectOptions(screen.getByLabelText("Column 3 size kind"), "content");
    expect(screen.queryByLabelText("Column 3 size")).toBeNull();
    const count = screen.getByRole("spinbutton", { name: "Columns" });
    fireEvent.change(count, { target: { value: "4" } });
    const columns = last(onChange).columns;
    expect(columns).toHaveLength(4);
    expect(columns[0].kind).toBe("fixed");
    expect(columns[2].kind).toBe("content");
    expect(columns[3]).toEqual({ kind: "fr", value: 1, min: null, max: null });
    await user.click(screen.getByRole("button", { name: "Add row" }));
    await user.selectOptions(screen.getByLabelText("Row 1 size kind"), "fixed");
    expect(last(onChange).rows).toEqual([{ kind: "fixed", value: 120, min: null, max: null }]);
    await user.click(screen.getByRole("button", { name: "Remove row 1" }));
    expect(last(onChange).rows).toEqual([]);
  });

  it("sets alignment and named regions", async () => {
    const onChange = vi.fn();
    render(<Harness initial={small()} onChange={onChange} />);
    await user.selectOptions(screen.getByLabelText("Horizontal alignment"), "center");
    await user.selectOptions(screen.getByLabelText("Vertical alignment"), "end");
    expect(last(onChange)).toMatchObject({ justifyItems: "center", alignItems: "end" });
    await user.click(screen.getByRole("button", { name: "Add region" }));
    const name = screen.getByLabelText("Region 1 name");
    await user.clear(name);
    await user.type(name, "header");
    await user.tab();
    expect(last(onChange).namedRegions).toEqual([
      { name: "header", column: 1, row: 1, columnSpan: 3, rowSpan: 1 },
    ]);
  });

  it("keeps half-typed and invalid track values out of the layout", async () => {
    const onChange = vi.fn();
    render(<Harness initial={small()} onChange={onChange} />);
    const size = screen.getByLabelText("Column 1 size");
    await user.clear(size);
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("Size must be a positive number.");
    await user.type(size, "0");
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
    await user.clear(size);
    await user.type(size, "2{Enter}");
    expect(last(onChange).columns[0].value).toBe(2);
    await user.type(screen.getByLabelText("Column 1 maximum pixels"), "50");
    await user.tab();
    await user.type(screen.getByLabelText("Column 1 minimum pixels"), "90");
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("Minimum cannot exceed maximum.");
    expect(last(onChange).columns[0]).toMatchObject({ min: null, max: 50 });
  });

  it("validates region names, reports renames, and clamps regions to the grid", async () => {
    const onChange = vi.fn();
    const layout: GridLayout = {
      ...small(),
      namedRegions: [
        { name: "a", column: 1, row: 1, columnSpan: 1, rowSpan: 1 },
        { name: "b", column: 2, row: 1, columnSpan: 1, rowSpan: 1 },
      ],
    };
    render(<Harness initial={layout} onChange={onChange} />);
    const name = screen.getByLabelText("Region 2 name");
    await user.clear(name);
    await user.type(name, "a");
    await user.tab();
    expect(screen.getByRole("alert")).toHaveTextContent("Another region is already named a.");
    expect(onChange).not.toHaveBeenCalled();
    await user.clear(name);
    await user.type(name, "side{Enter}");
    expect(onChange.mock.calls.at(-1)?.[1]).toEqual({ b: "side" });
    const span = screen.getByLabelText("Region 2 column span");
    await user.clear(span);
    await user.type(span, "9");
    await user.tab();
    expect(last(onChange).namedRegions[1]).toMatchObject({ column: 2, columnSpan: 2 });
    await user.click(screen.getByRole("button", { name: "Remove column 3" }));
    expect(last(onChange).namedRegions[1]).toMatchObject({ column: 2, columnSpan: 1 });
  });

  it("lists validation problems with item labels", async () => {
    const layout: GridLayout = {
      ...small(),
      namedRegions: [{ name: "wide", column: 1, row: 1, columnSpan: 5, rowSpan: 1 }],
    };
    const at = (column: number, columnSpan: number): Placement => ({
      column,
      row: 1,
      columnSpan,
      rowSpan: 1,
      region: null,
    });
    render(
      <Harness
        initial={layout}
        items={[
          { id: "a", label: "Name", placement: at(1, 2) },
          { id: "b", label: "Email", placement: at(2, 2) },
          { id: "c", label: "Logo", placement: { ...at(1, 1), region: "missing" } },
        ]}
      />,
    );
    const problems = within(screen.getByRole("list", { name: "Grid problems" }));
    expect(problems.getByText(/region wide/)).toBeTruthy();
    expect(problems.getByText("Name: overlaps Email")).toBeTruthy();
    expect(problems.getByText("Logo: placement references an unknown region")).toBeTruthy();
  });
});

describe("RegionPicker", () => {
  let user: ReturnType<typeof userEvent.setup>;
  beforeEach(() => {
    user = userEvent.setup();
  });

  it("places an item in a named region and back", async () => {
    const onChange = vi.fn();
    const layout: GridLayout = {
      ...small(),
      namedRegions: [{ name: "header", column: 1, row: 1, columnSpan: 3, rowSpan: 1 }],
    };
    const placement: Placement = { column: 2, row: 3, columnSpan: 1, rowSpan: 1, region: null };
    const { rerender } = render(
      <RegionPicker layout={layout} placement={placement} onChange={onChange} />,
    );
    await user.selectOptions(screen.getByLabelText("Region"), "header");
    expect(onChange).toHaveBeenLastCalledWith({ ...placement, region: "header" });
    rerender(
      <RegionPicker
        layout={layout}
        placement={{ ...placement, region: "header" }}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getByLabelText("Region"), "");
    expect(onChange).toHaveBeenLastCalledWith(placement);
    rerender(<RegionPicker layout={small()} placement={placement} onChange={onChange} />);
    expect(screen.queryByLabelText("Region")).toBeNull();
  });
});
