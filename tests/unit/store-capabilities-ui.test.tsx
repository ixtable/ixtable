import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CapabilitySummary } from "../../src/schema/CapabilitySummary";
import { ColumnFields } from "../../src/schema/ColumnFields";
import { emptyColumn } from "../../src/schema/columns";
import { ForeignKeyEditor } from "../../src/schema/ConstraintEditors";
import { storeLabel, storeTypes } from "../../src/schema/logical";
import type { StoreCapabilities } from "../../src/schema/types";

const capabilities: StoreCapabilities = {
  store: "postgres",
  logicalTypes: [
    { logicalType: "text", physicalType: "text", enforcement: "native type" },
    { logicalType: "integer", physicalType: "bigint", enforcement: "native type" },
    {
      logicalType: "decimal(p,s)",
      physicalType: "numeric(p,s)",
      enforcement: "native type",
      maxPrecision: 38,
    },
  ],
  ddl: [],
  constraints: ["primary key", "unique", "check"],
  foreignKeyActions: ["NO ACTION", "CASCADE"],
  indexes: { unique: true, multiColumn: true, partial: true, expression: false },
  transactions: {
    atomicBatches: true,
    transactionalDdl: true,
    savepoints: true,
    isolation: "read committed",
  },
  parameterStyle: "$1",
  generatedValues: ["identity columns"],
  migrations: { transactionalDdl: true, dryRun: "BEGIN … ROLLBACK", healthChecks: [], notes: "" },
  errorCodes: [
    {
      code: "CONSTRAINT_VIOLATION",
      constraint: "unique",
      native: "23505",
      description: "Duplicate value",
    },
  ],
  concurrency: {
    policies: ["optimistic"],
    optimisticCheck: "WHERE",
    rowLocking: true,
    multiUser: true,
    notes: "",
  },
};

describe("store capability language", () => {
  it("names the store only once capabilities are known", () => {
    expect(storeLabel(null)).toBeNull();
    expect(storeLabel(capabilities)).toBe("PostgreSQL");
    expect(storeLabel({ ...capabilities, store: "sqlite" })).toBe("SQLite");
    expect(storeTypes(null)).toBeUndefined();
    expect(storeTypes(capabilities)).toEqual(["text", "integer", "decimal"]);
  });

  it("offers only the store's logical types, keeping the current one", () => {
    const { rerender } = render(
      <ColumnFields
        draft={emptyColumn("a")}
        label="A"
        types={storeTypes(capabilities)}
        onChange={() => undefined}
      />,
    );
    const options = () =>
      within(screen.getByRole("combobox", { name: "A type" }))
        .getAllByRole("option")
        .map((o) => o.getAttribute("value"));
    expect(options()).toEqual(["text", "integer", "decimal"]);
    expect(screen.getByRole("textbox", { name: "A default" })).toHaveAttribute(
      "placeholder",
      "Default value or expression",
    );
    rerender(
      <ColumnFields
        draft={{ ...emptyColumn("a"), logicalType: "json" }}
        label="A"
        types={storeTypes(capabilities)}
        onChange={() => undefined}
      />,
    );
    expect(options()).toEqual(["text", "integer", "decimal", "json"]);
  });

  it("offers the store's referential actions and prefills a drawn relationship", () => {
    render(
      <ForeignKeyEditor
        columns={["part"]}
        tables={[{ name: "parts", columns: [] }]}
        actions={capabilities.foreignKeyActions}
        initial={{ columns: ["part"], targetTable: "parts", targetColumns: ["id"] }}
        onAdd={() => undefined}
      />,
    );
    const onDelete = screen.getByRole("combobox", { name: "On delete" });
    expect(
      within(onDelete)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["NO ACTION", "CASCADE"]);
    expect(screen.getByRole("checkbox", { name: "Relationship columns: part" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Target table" })).toHaveValue("parts");
  });

  it("summarizes the capability categories read-only", () => {
    render(<CapabilitySummary capabilities={capabilities} />);
    const summary = screen.getByRole("table", { name: "Store capabilities" });
    for (const name of [
      "Constraints",
      "Relationship actions",
      "Indexes",
      "Transactions",
      "Parameter style",
      "Generated values",
      "Migrations",
      "Concurrency",
    ])
      expect(within(summary).getByRole("rowheader", { name })).toBeInTheDocument();
    expect(summary).toHaveTextContent("partial yes · expression no");
    expect(summary).toHaveTextContent("$1");
    expect(screen.getByRole("table", { name: "Error codes" })).toHaveTextContent(
      "CONSTRAINT_VIOLATION (unique)23505Duplicate value",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
