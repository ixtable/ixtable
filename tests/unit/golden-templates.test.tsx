import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { TemplatePicker } = await import("../../src/shell/TemplatePicker");
const { toColumnValue } = await import("../../src/runtime/values");

const TEMPLATES = [
  { id: "crm", name: "CRM", description: "Companies and deals.", version: "1.0.0" },
  { id: "inventory", name: "Inventory", description: "Stock.", version: "1.0.0" },
  { id: "work-orders", name: "Work orders", description: "Maintenance.", version: "1.0.0" },
];

describe("TemplatePicker", () => {
  let user: ReturnType<typeof userEvent.setup>;
  beforeEach(() => {
    invoke.mockReset();
    user = userEvent.setup();
  });

  it("lists templates and creates the chosen one through the start screen runner", async () => {
    const state = { sessionId: "s1" };
    invoke.mockImplementation(async (command: string) =>
      command === "list_templates" ? TEMPLATES : state,
    );
    const run = vi.fn(async (_label: string, action: () => Promise<unknown>) => {
      await action();
    });
    render(<TemplatePicker disabled={false} run={run} />);
    expect(await screen.findByRole("heading", { name: "Start from a template" })).toBeVisible();
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Create CRM from template",
      "Create Inventory from template",
      "Create Work orders from template",
    ]);
    await user.click(screen.getByRole("button", { name: "Create Work orders from template" }));
    expect(run).toHaveBeenCalledWith("Creating Work orders…", expect.any(Function));
    expect(invoke).toHaveBeenLastCalledWith("create_from_template", {
      windowLabel: "main",
      templateId: "work-orders",
    });
  });

  it("renders nothing when no templates are listed", async () => {
    invoke.mockResolvedValue([]);
    const { container } = render(<TemplatePicker disabled={false} run={vi.fn()} />);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("disables the buttons while another start-screen action runs", async () => {
    invoke.mockResolvedValue(TEMPLATES);
    render(<TemplatePicker disabled run={vi.fn()} />);
    for (const button of await screen.findAllByRole("button")) expect(button).toBeDisabled();
  });
});

describe("golden template files", () => {
  const root = join(__dirname, "..", "..", "golden");
  const apps = ["crm", "inventory", "work-orders", "work-orders/v2"];

  it.each(apps)("%s: every asset placeholder names a file the template carries", (app) => {
    const yaml = readFileSync(join(root, app, "app.yaml"), "utf8");
    const dir = join(root, app.split("/")[0], "assets");
    const files = existsSync(dir) ? readdirSync(dir) : [];
    const definitions = yaml
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    const placeholders = [...definitions.matchAll(/\{\{asset:([^}]+)\}\}/g)].map((m) => m[1]);
    for (const name of placeholders) expect(files).toContain(name);
  });

  it.each(["crm", "inventory", "work-orders"])("%s: seed.sql only inserts rows", (app) => {
    const statements = readFileSync(join(root, app, "seed.sql"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements.length).toBeGreaterThan(3);
    for (const statement of statements) expect(statement).toMatch(/^INSERT INTO \w+ \(/);
  });
});

describe("boolean controls bound to INTEGER 0/1 columns (found by the golden apps)", () => {
  it("writes integers, not the text 'true'", () => {
    expect(toColumnValue(true, "INTEGER")).toEqual({ type: "integer", value: 1 });
    expect(toColumnValue(false, "INTEGER")).toEqual({ type: "integer", value: 0 });
    expect(toColumnValue(true, "BOOLEAN")).toEqual({ type: "boolean", value: true });
  });
});
