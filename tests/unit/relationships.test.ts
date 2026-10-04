import { describe, expect, it } from "vitest";
import { drawnFrom, isUniqueKey, relationshipEdges } from "../../src/data/relationships";
import type { DbForeignKey, TableSchema } from "../../src/lib/types";

const col = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  declaredType: "INTEGER",
  nullable: true,
  defaultValue: null,
  primaryKeyPosition: 0,
  generated: false,
  ...extra,
});
const fk = (from: string[], target: string, to: string[]): DbForeignKey => ({
  id: 0,
  fromColumns: from,
  targetTable: target,
  targetColumns: to,
  onUpdate: "NO ACTION",
  onDelete: "NO ACTION",
});
const table = (name: string, columns: string[], patch: Partial<TableSchema> = {}): TableSchema => ({
  name,
  columns: columns.map((c) => col(c)),
  foreignKeys: [],
  withoutRowid: false,
  ...patch,
});

const regions = table("regions", ["country", "code", "title"], { primaryKey: ["country", "code"] });
const sites = table("sites", ["id", "country", "code"], {
  primaryKey: ["id"],
  foreignKeys: [fk(["country", "code"], "regions", ["country", "code"])],
});
const profiles = table("profiles", ["id", "user_id"], {
  primaryKey: ["id"],
  uniques: [{ columns: ["user_id"] }],
  foreignKeys: [fk(["user_id"], "users", ["id"])],
});
const users = table("users", ["id"], { primaryKey: ["id"] });

describe("relationship diagram edges", () => {
  it("anchors every column of a composite key and labels it once", () => {
    const edges = relationshipEdges([regions, sites]);
    expect(edges).toEqual([
      {
        id: "sites-0-0",
        source: "regions",
        sourceHandle: "c0-source",
        target: "sites",
        targetHandle: "c1-target",
        label: "1 — ∞ (country, code)",
      },
      {
        id: "sites-0-1",
        source: "regions",
        sourceHandle: "c1-source",
        target: "sites",
        targetHandle: "c2-target",
      },
    ]);
  });

  it("labels one-to-one when the referencing columns are unique", () => {
    expect(relationshipEdges([users, profiles])[0].label).toBe("1 — 1");
    const keyed = table("details", ["user_id"], {
      primaryKey: ["user_id"],
      foreignKeys: [fk(["user_id"], "users", ["id"])],
    });
    expect(relationshipEdges([users, keyed])[0].label).toBe("1 — 1");
  });

  it("detects uniqueness from keys, constraints, indexes, and column flags", () => {
    expect(isUniqueKey(sites, ["id"])).toBe(true);
    expect(isUniqueKey(sites, ["country", "code"])).toBe(false);
    expect(isUniqueKey(regions, ["code", "country"])).toBe(true);
    expect(isUniqueKey(regions, ["code"])).toBe(false);
    const indexed = table("t", ["a"], {
      indexes: [{ name: "i", table: "t", columns: ["a"], unique: true }],
    });
    expect(isUniqueKey(indexed, ["a"])).toBe(true);
    const flagged = { ...table("t", []), columns: [col("a", { unique: true })] };
    expect(isUniqueKey(flagged, ["a"])).toBe(true);
  });
});

describe("drawing a relationship", () => {
  it("maps a connection from a parent column to a child column", () => {
    expect(
      drawnFrom(
        {
          source: "regions",
          sourceHandle: "c1-source",
          target: "sites",
          targetHandle: "c2-target",
        },
        [regions, sites],
      ),
    ).toEqual({
      childTable: "sites",
      childColumn: "code",
      parentTable: "regions",
      parentColumn: "code",
    });
  });

  it("ignores connections without a known table or column", () => {
    expect(
      drawnFrom(
        {
          source: "regions",
          sourceHandle: "c9-source",
          target: "sites",
          targetHandle: "c0-target",
        },
        [regions, sites],
      ),
    ).toBeNull();
    expect(drawnFrom({ source: null, target: "sites" }, [regions, sites])).toBeNull();
  });
});
