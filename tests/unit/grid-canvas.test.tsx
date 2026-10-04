import { render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GridCanvas, GridItem, defaultGridLayout } from "../../src/grid";
import type { GridLayout, Placement, SpanConstraints } from "../../src/grid";

const at = (column: number, row: number, columnSpan = 1, rowSpan = 1): Placement => ({
  column,
  row,
  columnSpan,
  rowSpan,
  region: null,
});

type Item = { id: string; label: string; placement: Placement; constraints?: SpanConstraints };

const layout: GridLayout = {
  ...defaultGridLayout(),
  breakpoints: [
    { minWidth: 0, columns: Array.from({ length: 4 }, () => ({ kind: "fr", value: 1 })) },
    { minWidth: 900, columns: defaultGridLayout().columns },
  ],
};

function Harness({
  initial,
  onResize,
}: {
  initial: Item[];
  onResize?: (id: string, placement: Placement) => void;
}) {
  const [items, setItems] = useState(initial);
  const [selected, setSelected] = useState<string>();
  const update = (id: string, placement: Placement) =>
    setItems((current) => current.map((item) => (item.id === id ? { ...item, placement } : item)));
  return (
    <GridCanvas
      layout={layout}
      label="Form layout"
      editable
      selectedId={selected}
      onSelect={setSelected}
      onResize={(id, placement) => {
        onResize?.(id, placement);
        update(id, placement);
      }}
      onMove={update}
    >
      {items.map((item) => (
        <GridItem
          key={item.id}
          id={item.id}
          label={item.label}
          placement={item.placement}
          constraints={item.constraints}
        >
          {`${item.label} at ${item.placement.column},${item.placement.row} size ${item.placement.columnSpan}x${item.placement.rowSpan}`}
        </GridItem>
      ))}
    </GridCanvas>
  );
}

let user: UserEvent;
beforeEach(() => {
  user = userEvent.setup();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GridCanvas", () => {
  it("resizes the selected item with labelled buttons", async () => {
    const onResize = vi.fn();
    render(
      <Harness
        initial={[{ id: "name", label: "Name", placement: at(1, 1, 4) }]}
        onResize={onResize}
      />,
    );
    expect(screen.queryByRole("button", { name: "Widen Name" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("group", { name: "Name" }));
    await user.click(screen.getByRole("button", { name: "Widen Name" }));
    await user.click(screen.getByRole("button", { name: "Make Name taller" }));
    await screen.findByText("Name at 1,1 size 5x2");
    expect(onResize).toHaveBeenLastCalledWith("name", at(1, 1, 5, 2));
    await user.click(screen.getByRole("button", { name: "Narrow Name" }));
    await user.click(screen.getByRole("button", { name: "Make Name shorter" }));
    await screen.findByText("Name at 1,1 size 4x1");
    expect(screen.getByRole("button", { name: "Make Name shorter" })).toBeDisabled();
  });

  it("resizes and moves with Alt and arrow keys inside declared constraints", async () => {
    render(
      <Harness
        initial={[
          {
            id: "notes",
            label: "Notes",
            placement: at(1, 1, 2),
            constraints: { minColumnSpan: 2, maxColumnSpan: 3 },
          },
        ]}
      />,
    );
    const item = screen.getByRole("group", { name: "Notes" });
    await user.tab();
    expect(item).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(within(item).getByRole("toolbar", { name: "Resize Notes" })).toBeInTheDocument();
    await user.keyboard("{Alt>}{ArrowRight}{ArrowRight}{ArrowRight}{/Alt}");
    await screen.findByText("Notes at 1,1 size 3x1");
    expect(screen.getByRole("button", { name: "Widen Notes" })).toBeDisabled();
    await user.keyboard("{Alt>}{ArrowLeft}{ArrowLeft}{ArrowDown}{/Alt}");
    await screen.findByText("Notes at 1,1 size 2x2");
    await user.keyboard("{Alt>}{Shift>}{ArrowRight}{ArrowDown}{/Shift}{/Alt}");
    await screen.findByText("Notes at 2,2 size 2x2");
  });

  it("applies the breakpoint for the measured width", () => {
    render(<Harness initial={[{ id: "a", label: "A", placement: at(1, 1, 12) }]} />);
    expect(screen.getByRole("group", { name: "Form layout" })).toHaveAttribute(
      "data-breakpoint",
      "1",
    );
  });

  it("uses the given width over the measured one", () => {
    render(
      <GridCanvas layout={layout} width={400} label="Narrow layout">
        <GridItem id="a" placement={at(1, 1, 12)}>
          A
        </GridItem>
      </GridCanvas>,
    );
    expect(screen.getByRole("group", { name: "Narrow layout" })).toHaveAttribute(
      "data-breakpoint",
      "0",
    );
    expect(screen.queryByRole("group", { name: "a" })).not.toBeInTheDocument();
  });

  it("snaps a pointer drag to whole tracks", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 50 }),
    );
    const onResize = vi.fn();
    render(
      <Harness
        initial={[{ id: "city", label: "City", placement: at(1, 1, 4) }]}
        onResize={onResize}
      />,
    );
    const grip = screen.getByTitle("Drag to resize City");
    await user.pointer([
      { keys: "[MouseLeft>]", target: grip, coords: { clientX: 0, clientY: 0 } },
      { target: grip, coords: { clientX: 110, clientY: 70 } },
      { keys: "[/MouseLeft]", target: grip },
    ]);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith("city", at(1, 1, 6, 2));
    await screen.findByText("City at 1,1 size 6x2");
  });
});
