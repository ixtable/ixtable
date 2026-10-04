import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it } from "vitest";
import { DialogFrame } from "../../src/components/DialogFrame";

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
});

function Harness({ autofocus }: { autofocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <DialogFrame role="dialog" aria-label="Sample" onClose={() => setOpen(false)}>
          <button type="button">Danger</button>
          <button type="button" data-autofocus={autofocus || undefined}>
            Cancel
          </button>
        </DialogFrame>
      )}
    </>
  );
}

it("moves focus in, closes on Escape, and restores focus to the opener", async () => {
  render(<Harness />);
  await user.tab();
  const opener = await screen.findByRole("button", { name: "Open" });
  expect(opener).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("button", { name: "Danger" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(opener).toHaveFocus();
});

it("prefers the data-autofocus element", async () => {
  render(<Harness autofocus />);
  await user.click(await screen.findByRole("button", { name: "Open" }));
  expect(await screen.findByRole("button", { name: "Cancel" })).toHaveFocus();
});
