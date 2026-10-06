import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import App from "../../src/App";
import { OPEN_FILES_EVENT } from "../../src/lib/launch";
import { emitTauriEvent } from "./setup";

// Archives written by a newer ixtable (docs/decisions/archive-format.md).
const LONG = { timeout: 20_000 };
const fixtures = join(__dirname, "../fixtures/archives/newer-build");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function workingCopy(file: string) {
  const path = join(process.env.IXTABLE_STATE_DIR!, file);
  copyFileSync(join(fixtures, file), path);
  return path;
}

it.each([
  ["newer-format.ixt", /created by a newer ixtable \(format 99\)\. Update ixtable to open it\./],
  [
    "newer-config.ixt",
    /configuration \(version 99\) was created by a newer ixtable\. Update ixtable to open it\./,
  ],
])(
  "refuses %s with an update hint and leaves the file untouched",
  async (file, message) => {
    const path = workingCopy(file);
    const before = sha(path);
    render(<App />);
    await screen.findByRole("button", { name: /New document/ }, LONG);
    emitTauriEvent(OPEN_FILES_EVENT, [path]);
    const alert = await screen.findByRole("alert", {}, LONG);
    expect(within(alert).getByText("UNSUPPORTED_VERSION")).toBeInTheDocument();
    expect(within(alert).getByText(message)).toBeInTheDocument();
    expect(screen.queryByText("PROJECT")).not.toBeInTheDocument();
    expect(sha(path)).toBe(before);
  },
  60_000,
);

it("opens an archive with unknown entries at the current versions", async () => {
  const path = workingCopy("unknown-entries.ixt");
  render(<App />);
  await screen.findByRole("button", { name: /New document/ }, LONG);
  emitTauriEvent(OPEN_FILES_EVENT, [path]);
  expect(await screen.findByText("PROJECT", {}, LONG)).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
}, 60_000);
