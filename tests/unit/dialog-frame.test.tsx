import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it } from "vitest";
import { DialogFrame } from "../../src/components/DialogFrame";

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
});

function Harness({ autofocus, busy }: { autofocus?: boolean; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <DialogFrame role="dialog" aria-label="Sample" busy={busy} onClose={() => setOpen(false)}>
          <button type="button">Danger</button>
          <button type="button" disabled>
            Off
          </button>
          <button type="button" data-autofocus={autofocus || undefined}>
            Cancel
          </button>
          <button type="button" hidden>
            Hidden
          </button>
        </DialogFrame>
      )}
      <button type="button">Behind</button>
    </>
  );
}

function RemovingHarness() {
  const [rows, setRows] = useState(["a", "b"]);
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <>
      <ul aria-label="Rows" tabIndex={-1} id="rows">
        {rows.map((row) => (
          <li key={row}>
            <button type="button" onClick={() => setConfirming(row)}>
              Delete {row}
            </button>
          </li>
        ))}
      </ul>
      {confirming && (
        <DialogFrame
          role="dialog"
          aria-label="Confirm"
          onClose={() => setConfirming(null)}
          fallbackFocus={() => document.getElementById("rows")}
        >
          <button
            type="button"
            onClick={() => {
              setRows(rows.filter((r) => r !== confirming));
              setConfirming(null);
            }}
          >
            Yes
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

it("wraps Tab from the last element to the first and Shift+Tab from the first to the last", async () => {
  render(<Harness />);
  await user.click(await screen.findByRole("button", { name: "Open" }));
  const danger = await screen.findByRole("button", { name: "Danger" });
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(danger).toHaveFocus();
  await user.tab({ shift: true });
  expect(cancel).toHaveFocus();
  await user.tab();
  expect(danger).toHaveFocus();
  await user.tab();
  expect(cancel).toHaveFocus();
  await user.tab();
  expect(danger).toHaveFocus();
});

it("ignores Escape while busy", async () => {
  render(<Harness busy />);
  await user.click(await screen.findByRole("button", { name: "Open" }));
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "Sample" })).toBeInTheDocument();
});

it("focuses the fallback target when the opener was removed", async () => {
  render(<RemovingHarness />);
  await user.click(await screen.findByRole("button", { name: "Delete a" }));
  await user.click(await screen.findByRole("button", { name: "Yes" }));
  await waitFor(() => expect(screen.getByRole("list", { name: "Rows" })).toHaveFocus());
  expect(screen.queryByRole("button", { name: "Delete a" })).toBeNull();
});
