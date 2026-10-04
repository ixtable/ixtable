import { describe, expect, it } from "vitest";
import type { TableSchema } from "../../src/lib/types";
import { columnCheck, draftFromColumn } from "../../src/schema/columns";

const schema = (checks: string[]) =>
  ({
    name: "t",
    columns: [
      { name: "qty", declaredType: "INTEGER", nullable: true },
      { name: "max", declaredType: "INTEGER", nullable: true },
    ],
    checks: checks.map((expression) => ({ expression })),
  }) as unknown as TableSchema;

describe("column checks", () => {
  it("shows checks that mention only this column as the column's check", () => {
    const s = schema(["qty > 0", "qty <= max", "\"MAX\" < 'qty'"]);
    expect(columnCheck(s, "qty")).toBe("qty > 0");
    expect(columnCheck(s, "max")).toBe("\"MAX\" < 'qty'");
    expect(draftFromColumn(s.columns[0], s).check).toBe("qty > 0");
  });

  it("joins several checks the way the store compares them and is empty without any", () => {
    expect(columnCheck(schema(["qty > 0", " QTY < 9 "]), "qty")).toBe("(qty > 0) AND (QTY < 9)");
    expect(columnCheck(schema([]), "qty")).toBe("");
  });
});
