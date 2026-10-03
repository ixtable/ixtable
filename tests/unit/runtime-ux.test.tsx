import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignControl } from "../../src/design/schema";
import type { DocumentConfig } from "../../src/lib/types";

const pending = vi.hoisted(() => [] as Array<(page: unknown) => void>);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command === "inspect_table")
      return {
        name: "customers",
        columns: [
          { name: "id", declaredType: "INTEGER", primaryKeyPosition: 1, nullable: false },
          { name: "name", declaredType: "TEXT", primaryKeyPosition: 0, nullable: true },
        ],
        foreignKeys: [],
        withoutRowid: false,
      };
    if (command === "read_table_page") return new Promise((resolve) => pending.push(resolve));
    throw new Error(`unexpected ${command}`);
  },
}));

const { Field } = await import("../../src/runtime/controls");
const { BooleanCell } = await import("../../src/runtime/BooleanCell");
const { booleanValue, isBooleanColumn } = await import("../../src/runtime/values");
const { pageTitle } = await import("../../src/runtime/navigation");

const customerPage = (name: string) => ({
  columns: [
    { name: "id", declaredType: "INTEGER" },
    { name: "name", declaredType: "TEXT" },
  ],
  rows: [
    [
      { type: "integer", value: 1 },
      { type: "text", value: name },
    ],
  ],
  identities: [[{ type: "integer", value: 1 }]],
  total: 1,
});

const customer: DesignControl = {
  id: "c",
  kind: "relationship",
  label: "Customer",
  binding: { column: "customer_id" },
  relationship: { table: "customers", valueColumn: "id", displayColumn: "name" },
  placement: { column: 1, row: 1, columnSpan: 6, rowSpan: 1 },
} as DesignControl;

const field = () => (
  <Field
    control={customer}
    value={1}
    onChange={() => undefined}
    onBlur={() => undefined}
    readOnly
  />
);

beforeEach(() => {
  pending.length = 0;
});

describe("read-only relationship field", () => {
  it("keeps the last label while a reloaded record revalidates it", async () => {
    const first = render(field());
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0](customerPage("Northstar Goods")));
    expect(screen.getByRole("textbox", { name: "Customer" })).toHaveValue("Northstar Goods");
    first.unmount();

    render(field());
    expect(screen.getByRole("textbox", { name: "Customer" })).toHaveValue("Northstar Goods");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1](customerPage("Northstar Goods Ltd")));
    expect(screen.getByRole("textbox", { name: "Customer" })).toHaveValue("Northstar Goods Ltd");
  });
});

describe("boolean list cells", () => {
  it("decides from the bound control or the column type, never from 0/1 values", () => {
    expect(isBooleanColumn([{ kind: "boolean" }], { declaredType: "INTEGER" })).toBe(true);
    expect(isBooleanColumn([undefined], { declaredType: "BOOLEAN" })).toBe(true);
    expect(isBooleanColumn([], { declaredType: "INTEGER", logicalType: "boolean" })).toBe(true);
    expect(isBooleanColumn([{ kind: "number" }], { declaredType: "INTEGER" })).toBe(false);
    expect(isBooleanColumn([], undefined)).toBe(false);
  });

  it("reads stored yes/no values", () => {
    expect([1, 0, "1", "0", true, false, "true", "false"].map(booleanValue)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(booleanValue(null)).toBeNull();
  });

  it("renders a checkmark or a dash with Yes/No for assistive tech", () => {
    render(
      <table>
        <tbody>
          <tr>
            <td>
              <BooleanCell value={1} />
            </td>
            <td>
              <BooleanCell value={0} />
            </td>
            <td>
              <BooleanCell value={null} />
            </td>
          </tr>
        </tbody>
      </table>,
    );
    const cells = screen.getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual(["Yes", "–No", ""]);
    expect(screen.getByRole("cell", { name: "Yes" }).querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("1")).toBeNull();
  });
});

describe("runtime back link titles", () => {
  const config = {
    design: {
      version: 3,
      forms: [{ id: "f1", name: "Work order" }],
      navigation: [
        {
          id: "n1",
          label: "Maintenance",
          kind: "group",
          children: [{ id: "n2", label: "Work orders", kind: "form", targetId: "f1" }],
        },
      ],
    },
    reports: [{ id: "r1", name: "Work order sheet" }],
    dashboards: [],
  } as unknown as DocumentConfig;

  it("names the previous page by its navigation label, else its target", () => {
    expect(pageTitle(config, { kind: "form", id: "f1", navId: "n2" })).toBe("Work orders");
    expect(pageTitle(config, { kind: "form", id: "f1" })).toBe("Work order");
    expect(pageTitle(config, { kind: "report", id: "r1" })).toBe("Work order sheet");
    expect(pageTitle(config, { kind: "table", id: "order_items" })).toBe("Order items");
    expect(pageTitle(config, { kind: "dashboard", id: "gone" })).toBe("previous page");
  });
});
