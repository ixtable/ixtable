import { describe, expect, it } from "vitest";
import {
  cleanOptions,
  defaultColumns,
  defaultMapping,
  defaultPrimaryKey,
  existingTableTarget,
  identifier,
  nameFromPath,
  newTableTarget,
} from "../../src/import/mapping";
import type { FilePreview } from "../../src/import/types";
import type { TableSchema } from "../../src/lib/types";

const preview = (names: string[]): FilePreview => ({
  format: "csv",
  columns: names.map((name) => ({ name, logicalType: "text" })),
  rows: [],
  totalRows: 0,
  sheets: [],
});

describe("import mapping", () => {
  it("turns file and column names into identifiers", () => {
    expect(identifier("Team Members!")).toBe("team_members");
    expect(identifier("2024 sales")).toBe("_2024_sales");
    expect(identifier("***")).toBe("imported");
    expect(nameFromPath("C:\\data\\Q1 Orders.csv")).toBe("q1_orders");
    expect(nameFromPath("/tmp/sales.v2.parquet")).toBe("sales_v2");
  });

  it("drafts unique new-table columns and keys an id column", () => {
    const drafts = defaultColumns(preview(["ID", "Name", "name", ""]));
    expect(drafts.map((d) => d.name)).toEqual(["id", "name", "name_2", "column_4"]);
    expect(defaultPrimaryKey(drafts)).toBe("id");
    drafts[0].include = false;
    expect(defaultPrimaryKey(drafts)).toBe("");
    expect(newTableTarget("t", drafts, "")).toEqual({
      kind: "newTable",
      table: "t",
      primaryKey: null,
      columns: [
        { source: "Name", name: "name", logicalType: "text" },
        { source: "name", name: "name_2", logicalType: "text" },
        { source: "", name: "column_4", logicalType: "text" },
      ],
    });
  });

  it("maps file columns to fields with the same name and skips the rest", () => {
    const table = {
      name: "members",
      columns: [
        { name: "full_name", generated: false },
        { name: "Age", generated: false },
        { name: "label", generated: true },
      ],
    } as unknown as TableSchema;
    const mapping = defaultMapping(preview(["Full Name", "age", "Label", "Other"]), table);
    expect(mapping).toEqual({ "Full Name": "full_name", age: "Age", Label: "", Other: "" });
    expect(existingTableTarget("members", mapping)).toEqual({
      kind: "existingTable",
      table: "members",
      mapping: [
        { source: "Full Name", field: "full_name" },
        { source: "age", field: "Age" },
      ],
    });
  });

  it("sends empty delimiter and sheet as detect and first", () => {
    expect(cleanOptions({ header: false, delimiter: "", sheet: "" })).toEqual({
      header: false,
      delimiter: null,
      sheet: null,
    });
  });
});
