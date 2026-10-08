import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "vitest";
import { TrackList } from "../../src/design/TrackList";
import type { GridTrack } from "../../src/grid/types";
import { PointInput } from "../../src/reports/designer/fields";

function Band({ min }: { min: number }) {
  const [height, setHeight] = useState(min);
  return (
    <>
      <PointInput label="Band height" min={min} value={height} onChange={setHeight} />
      <output>{height}</output>
    </>
  );
}

it("lets a clamped point value be cleared and retyped", async () => {
  const user = userEvent.setup();
  render(<Band min={20} />);
  const input = screen.getByRole("spinbutton", { name: "Band height" });
  await user.clear(input);
  await user.type(input, "60");
  expect(input).toHaveValue(60);
  expect(screen.getByRole("status")).toHaveTextContent("60");
  await user.clear(input);
  await user.type(input, "5");
  await user.tab();
  expect(input).toHaveValue(60);
});

it("labels each track's kind, size and limits", () => {
  const tracks: GridTrack[] = [{ kind: "fixed", value: 120, min: null, max: 300 }];
  render(<TrackList name="Column" tracks={tracks} onChange={() => undefined} />);
  expect(screen.getByText("Column 1")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Column 1 size kind" })).toHaveValue("fixed");
  expect(screen.getByText("Size px")).toBeInTheDocument();
  expect(screen.getByRole("spinbutton", { name: "Column 1 size" })).toHaveValue(120);
  expect(screen.getByText("Min px")).toBeInTheDocument();
  expect(screen.getByRole("spinbutton", { name: "Column 1 maximum pixels" })).toHaveValue(300);
});
