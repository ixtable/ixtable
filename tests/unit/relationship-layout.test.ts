import { describe, expect, it } from "vitest";
import { defaultLayout } from "../../src/data/layout";

const table = (fields: number) => ({
  columns: Array.from({ length: fields }, () => ({})) as never,
});

describe("relationship diagram default layout", () => {
  it("places three tables per row with the original spacing for small tables", () => {
    expect(defaultLayout([table(2), table(3), table(4), table(1)])).toEqual([
      { x: 30, y: 25 },
      { x: 330, y: 25 },
      { x: 630, y: 25 },
      { x: 30, y: 215 },
    ]);
  });

  it("starts the next row below the tallest table of the row above", () => {
    const [, , , next] = defaultLayout([table(3), table(10), table(2), table(1)]);
    expect(next).toEqual({ x: 30, y: 25 + 280 + 50 });
  });

  it("returns no positions for no tables", () => {
    expect(defaultLayout([])).toEqual([]);
  });
});
