import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignControl } from "../../src/design/schema";

const readTablePage = vi.fn();
vi.mock("../../src/lib/api", () => ({
  call: vi.fn(),
  inspectTable: vi.fn(),
  readTablePage: (...args: unknown[]) => readTablePage(...args),
}));
vi.mock("../../src/lib/config-store", () => ({ useDocumentConfig: () => ({ config: {} }) }));

const { Field } = await import("../../src/runtime/controls");

const controls = new Map<string, DesignControl>();
const make = (filter: string) =>
  ({
    id: "c",
    kind: "relationship",
    label: "Customer",
    binding: { column: "customer_id" },
    relationship: { table: "customers", valueColumn: "id", displayColumn: "name", filter },
  }) as unknown as DesignControl;
const control = (filter: string) => {
  const hit = controls.get(filter) ?? make(filter);
  controls.set(filter, hit);
  return hit;
};
const scope = (form: Record<string, unknown>) => ({ parent: {}, form, app: {}, params: {} });
const field = (filter: string, form: Record<string, unknown>) => (
  <Field
    control={control(filter)}
    value={null}
    onChange={() => undefined}
    onBlur={() => undefined}
    readOnly={false}
    filterScope={scope(form)}
  />
);
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

beforeEach(() => {
  readTablePage.mockReset();
  readTablePage.mockResolvedValue({
    columns: [
      { name: "id", declaredType: "INTEGER" },
      { name: "name", declaredType: "TEXT" },
      { name: "region", declaredType: "TEXT" },
    ],
    rows: [
      [
        { type: "integer", value: 1 },
        { type: "text", value: "Acme" },
        { type: "text", value: "East" },
      ],
      [
        { type: "integer", value: 2 },
        { type: "text", value: "Globex" },
        { type: "text", value: "West" },
      ],
    ],
    identities: [],
    total: 2,
    offset: 0,
    limit: 500,
  });
});

describe("relationship choice filter", () => {
  it("reloads choices only when a value the filter reads changes", async () => {
    const filter = "record.region = form.region";
    const { rerender } = render(field(filter, { region: "East", note: "a" }));
    expect(await screen.findByRole("option", { name: "Acme" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Globex" })).toBeNull();
    const calls = readTablePage.mock.calls.length;
    rerender(field(filter, { region: "East", note: "ab" }));
    rerender(field(filter, { region: "East", note: "abc" }));
    await settle();
    expect(readTablePage.mock.calls.length).toBe(calls);
    rerender(field(filter, { region: "West", note: "abc" }));
    expect(await screen.findByRole("option", { name: "Globex" })).toBeInTheDocument();
    expect(readTablePage.mock.calls.length).toBeGreaterThan(calls);
  });

  it("shows a filter that fails to parse instead of an empty list", async () => {
    render(field("record.region =", {}));
    expect(await screen.findByRole("alert")).toHaveTextContent(/^Choice filter: /);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
  });
});
