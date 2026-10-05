import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { beforeAll, describe, expect, it } from "vitest";
import App from "../../src/App";
import { OPEN_FILES_EVENT } from "../../src/lib/launch";
import { invalidateRuntimeCache } from "../../src/runtime/data";
import { emitTauriEvent } from "../integration/setup";
import { FIXTURE, hasFixture, record, sample } from "./report";

const LONG = { timeout: 60_000 };
const FAST = { timeout: 60_000, interval: 5 };
const nav = () => screen.getByRole("navigation", { name: "Application navigation" });
const page = () => screen.getByRole("region", { name: "Application page" });
let user: ReturnType<typeof userEvent.setup>;
beforeAll(() => {
  user = userEvent.setup({ delay: null });
});

let copies = 0;
async function openFixture() {
  cleanup();
  await invoke("close_document", { windowLabel: "main", force: true }).catch(() => undefined);
  const path = join(process.env.IXTABLE_STATE_DIR!, `perf-${copies++}.ixt`);
  copyFileSync(FIXTURE, path);
  render(<App />);
  await screen.findByRole("button", { name: /New document/ }, LONG);
  const t0 = performance.now();
  emitTauriEvent(OPEN_FILES_EVENT, [path]);
  await screen.findByRole("navigation", { name: "Application navigation" }, LONG);
  return performance.now() - t0;
}

async function showList(label: string, row: RegExp) {
  const t0 = performance.now();
  await user.click(within(nav()).getByRole("button", { name: label }));
  await waitFor(() => {
    const list = within(page()).getByRole("region", { name: label });
    expect(within(list).getAllByRole("row", { name: row }).length).toBeGreaterThan(0);
  }, FAST);
  return performance.now() - t0;
}

describe.skipIf(!hasFixture())("performance budgets (UI)", () => {
  it("application open after warm start", async () => {
    const samples = await sample(openFixture);
    record(
      "open-ui",
      "Application open after warm start (UI)",
      3000,
      samples,
      "open event to Runtime navigation shown, real Rust bridge",
    );
  });

  it("runtime navigation between already loaded pages", async () => {
    await openFixture();
    await showList("Companies", /^Open /);
    await showList("Contacts", /^Open /);
    let next = "Companies";
    const samples = await sample(async () => {
      const ms = await showList(next, /^Open /);
      next = next === "Companies" ? "Contacts" : "Companies";
      return ms;
    });
    record(
      "navigate-loaded",
      "Runtime navigation between already loaded pages",
      200,
      samples,
      "Companies <-> Contacts after both lists loaded once",
    );
  });

  it("filtered list over 50,000 rows", async () => {
    await openFixture();
    const samples = await sample(async () => {
      await showList("Companies", /^Open /);
      invalidateRuntimeCache(true);
      return showList("Deals", /^Open Perf deal/);
    });
    record(
      "filtered-list",
      "Filtered list, cold (row filter over 50,000 deals)",
      null,
      samples,
      "Deals list with `record.amount >= 99000` (500 matches), caches dropped before each sample",
    );
  });

  it("local field edit acknowledgement", async () => {
    await openFixture();
    await showList("Companies", /^Open /);
    await user.click(await within(page()).findByRole("row", { name: "Open Acme Corp" }, LONG));
    const company = await within(page()).findByRole("form", { name: "Company" }, LONG);
    await user.click(await within(company).findByRole("button", { name: "Edit" }, LONG));
    const input = await within(page()).findByRole("textbox", { name: "Name" }, LONG);
    let n = 0;
    const samples = await sample(async () => {
      const value = `Acme Corp ${++n}`;
      const t0 = performance.now();
      act(() => {
        fireEvent.change(input, { target: { value } });
      });
      const ms = performance.now() - t0;
      expect(input).toHaveValue(value);
      return ms;
    });
    record(
      "field-edit",
      "Local field edit acknowledgement",
      100,
      samples,
      "change event to rendered value in the Company edit form (no backend call)",
    );
  });
});
