import { describe, expect, it } from "vitest";
import {
  compileBuilder,
  quoteIdent,
  quoteLiteral,
  tryCompile,
} from "../../src/query/builder/compile";
import {
  type BuilderModel,
  builderParameterNames,
  emptyModel,
  normalizeModel,
  aliasFor,
} from "../../src/query/builder/model";
import { toDataValue, toNamedValues } from "../../src/query/api";

const model = (patch: Partial<BuilderModel>): BuilderModel => ({ ...emptyModel(), ...patch });
const orders = { id: "s1", table: "orders", alias: "o" };
const customers = { id: "s2", table: "customers", alias: "c" };

describe("compileBuilder", () => {
  it("requires a source", () => {
    expect(() => compileBuilder(emptyModel())).toThrow(/source/);
    expect(tryCompile(emptyModel()).error).toMatch(/source/);
  });

  it("selects every column when no field is chosen", () => {
    expect(compileBuilder(model({ sources: [orders] }))).toBe('SELECT *\nFROM "orders" AS "o"');
  });

  it("quotes identifiers and aliases", () => {
    const sql = compileBuilder(
      model({
        sources: [{ id: "s", table: 'we"ird table', alias: "w" }],
        fields: [
          {
            id: "f",
            source: "w",
            column: 'col"; DROP TABLE x; --',
            alias: 'A "b"',
            selected: true,
          },
        ],
      }),
    );
    expect(sql).toBe(
      'SELECT "w"."col""; DROP TABLE x; --" AS "A ""b"""\nFROM "we""ird table" AS "w"',
    );
  });

  it("compiles inner and left joins", () => {
    const sql = compileBuilder(
      model({
        sources: [orders, customers, { id: "s3", table: "regions", alias: "r" }],
        joins: [
          {
            id: "j1",
            kind: "inner",
            source: "c",
            conditions: [{ leftSource: "o", leftColumn: "customer_id", rightColumn: "id" }],
          },
          {
            id: "j2",
            kind: "left",
            source: "r",
            conditions: [{ leftSource: "c", leftColumn: "region_id", rightColumn: "id" }],
          },
        ],
        fields: [
          { id: "f1", source: "o", column: "id", selected: true },
          { id: "f2", source: "c", column: "name", alias: "customer", selected: true },
          { id: "f3", source: "r", column: "name", selected: false },
        ],
      }),
    );
    expect(sql).toBe(
      [
        'SELECT "o"."id" AS "id", "c"."name" AS "customer"',
        'FROM "orders" AS "o"',
        'INNER JOIN "customers" AS "c" ON "o"."customer_id" = "c"."id"',
        'LEFT JOIN "regions" AS "r" ON "c"."region_id" = "r"."id"',
      ].join("\n"),
    );
  });

  it("rejects joins that are missing or refer to later sources", () => {
    expect(() => compileBuilder(model({ sources: [orders, customers] }))).toThrow(/join/);
    expect(() =>
      compileBuilder(
        model({
          sources: [orders, customers],
          joins: [
            {
              id: "j",
              kind: "inner",
              source: "c",
              conditions: [{ leftSource: "x", leftColumn: "a", rightColumn: "b" }],
            },
          ],
        }),
      ),
    ).toThrow(/refers to x/);
  });

  it("groups non-aggregated fields, aggregates, and filters with having and params", () => {
    const sql = compileBuilder(
      model({
        sources: [orders],
        fields: [
          { id: "f1", source: "o", column: "customer", selected: true },
          { id: "f2", source: "o", column: "amount", aggregate: "sum", selected: true },
          {
            id: "f3",
            source: "o",
            column: "*",
            aggregate: "count",
            alias: "orders",
            selected: true,
          },
          { id: "f4", source: "o", column: "sku", aggregate: "countDistinct", selected: true },
        ],
        filters: {
          id: "g",
          kind: "group",
          combinator: "and",
          items: [
            {
              id: "c1",
              kind: "condition",
              source: "o",
              column: "status",
              operator: "=",
              value: { kind: "value", value: "paid" },
            },
            {
              id: "g2",
              kind: "group",
              combinator: "or",
              items: [
                {
                  id: "c2",
                  kind: "condition",
                  source: "o",
                  column: "placed",
                  operator: ">=",
                  value: { kind: "param", name: "since" },
                },
                { id: "c3", kind: "condition", source: "o", column: "placed", operator: "isNull" },
              ],
            },
          ],
        },
        having: {
          id: "h",
          kind: "group",
          combinator: "and",
          items: [
            {
              id: "h1",
              kind: "condition",
              source: "o",
              column: "amount",
              aggregate: "sum",
              operator: ">",
              value: { kind: "param", name: "min_total" },
            },
          ],
        },
        orderBy: [{ id: "s", fieldId: "f2", direction: "desc" }],
        limit: 10,
      }),
    );
    expect(sql).toBe(
      [
        'SELECT "o"."customer" AS "customer", sum("o"."amount") AS "sum_amount", count(*) AS "orders", count(DISTINCT "o"."sku") AS "count_distinct_sku"',
        'FROM "orders" AS "o"',
        `WHERE ("o"."status" = 'paid') AND (("o"."placed" >= $since) OR ("o"."placed" IS NULL))`,
        'GROUP BY "o"."customer"',
        'HAVING sum("o"."amount") > $min_total',
        'ORDER BY sum("o"."amount") DESC',
        "LIMIT 10",
      ].join("\n"),
    );
  });

  it("uses explicit group by without aggregates", () => {
    const sql = compileBuilder(
      model({
        sources: [orders],
        fields: [{ id: "f", source: "o", column: "customer", selected: true }],
        groupBy: [{ source: "o", column: "customer" }],
      }),
    );
    expect(sql).toContain('GROUP BY "o"."customer"');
  });

  it("groups by a column that is not output and groups the output fields with it", () => {
    const sql = compileBuilder(
      model({
        sources: [orders],
        fields: [{ id: "f", source: "o", column: "status", selected: true }],
        groupBy: [{ source: "o", column: "region" }],
      }),
    );
    expect(sql).toBe(
      'SELECT "o"."status" AS "status"\nFROM "orders" AS "o"\nGROUP BY "o"."region", "o"."status"',
    );
  });

  it("sorts by a field that is not output", () => {
    const sql = compileBuilder(
      model({
        sources: [orders],
        fields: [
          { id: "a", source: "o", column: "id", selected: true },
          { id: "b", source: "o", column: "placed", selected: false },
        ],
        orderBy: [{ id: "s", fieldId: "b", direction: "desc" }],
      }),
    );
    expect(sql).toBe('SELECT "o"."id" AS "id"\nFROM "orders" AS "o"\nORDER BY "o"."placed" DESC');
  });

  it("asks to group a hidden sort field when the query groups", () => {
    const { error } = tryCompile(
      model({
        sources: [orders],
        fields: [
          { id: "a", source: "o", column: "id", aggregate: "count", selected: true },
          { id: "b", source: "o", column: "placed", selected: false },
        ],
        orderBy: [{ id: "s", fieldId: "b", direction: "asc" }],
      }),
    );
    expect(error).toMatch(/placed needs it in Group by/);
  });

  it("compiles right and full outer joins with several conditions", () => {
    const joined = (kind: "right" | "full") =>
      compileBuilder(
        model({
          sources: [orders, customers],
          joins: [
            {
              id: "j",
              kind,
              source: "c",
              conditions: [
                { leftSource: "o", leftColumn: "customer_id", rightColumn: "id" },
                { leftSource: "o", leftColumn: "region", rightColumn: "region" },
              ],
            },
          ],
        }),
      );
    expect(joined("right")).toContain(
      'RIGHT JOIN "customers" AS "c" ON "o"."customer_id" = "c"."id" AND "o"."region" = "c"."region"',
    );
    expect(joined("full")).toContain('FULL OUTER JOIN "customers" AS "c" ON');
  });

  it("escapes literal injection attempts and rejects unsafe parameter names", () => {
    const base = model({ sources: [orders] });
    const where = (
      value:
        | { kind: "value"; value: string | number | boolean | null }
        | { kind: "param"; name: string },
    ) =>
      compileBuilder({
        ...base,
        filters: {
          id: "g",
          kind: "group",
          combinator: "and",
          items: [
            { id: "c", kind: "condition", source: "o", column: "name", operator: "=", value },
          ],
        },
      });
    expect(where({ kind: "value", value: "x' OR '1'='1" })).toContain(
      `WHERE "o"."name" = 'x'' OR ''1''=''1'`,
    );
    expect(where({ kind: "value", value: 5 })).toContain('"o"."name" = 5');
    expect(where({ kind: "value", value: true })).toContain('"o"."name" = TRUE');
    expect(() => where({ kind: "param", name: "x; DROP TABLE o" })).toThrow(/parameter name/);
    expect(() => where({ kind: "param", name: "1abc" })).toThrow(/parameter name/);
    expect(() => where({ kind: "value", value: Number.NaN })).toThrow(/finite/);
  });

  it("compiles contains and starts-with case-insensitively", () => {
    const sql = compileBuilder(
      model({
        sources: [orders],
        filters: {
          id: "g",
          kind: "group",
          combinator: "or",
          items: [
            {
              id: "a",
              kind: "condition",
              source: "o",
              column: "name",
              operator: "contains",
              value: { kind: "param", name: "q" },
            },
            {
              id: "b",
              kind: "condition",
              source: "o",
              column: "name",
              operator: "startsWith",
              value: { kind: "value", value: "Ac" },
            },
          ],
        },
      }),
    );
    expect(sql).toContain(
      `WHERE (contains(lower(CAST("o"."name" AS VARCHAR)), lower($q))) OR (starts_with(lower(CAST("o"."name" AS VARCHAR)), lower('Ac')))`,
    );
  });

  it("rejects aggregates in WHERE, * without count, and bad limits", () => {
    const base = model({ sources: [orders] });
    expect(() =>
      compileBuilder({
        ...base,
        filters: {
          id: "g",
          kind: "group",
          combinator: "and",
          items: [
            {
              id: "c",
              kind: "condition",
              source: "o",
              column: "a",
              aggregate: "sum",
              operator: ">",
              value: { kind: "value", value: 1 },
            },
          ],
        },
      }),
    ).toThrow(/Having/);
    expect(() =>
      compileBuilder({
        ...base,
        fields: [{ id: "f", source: "o", column: "*", aggregate: "sum", selected: true }],
      }),
    ).toThrow(/Count/);
    expect(() => compileBuilder({ ...base, limit: 1.5 })).toThrow(/Limit/);
    expect(() =>
      compileBuilder({ ...base, orderBy: [{ id: "s", fieldId: "gone", direction: "asc" }] }),
    ).toThrow(/Sort/);
  });
});

describe("builder helpers", () => {
  it("quotes", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteLiteral(null)).toBe("NULL");
  });
  it("normalizes partial models and lists parameter names", () => {
    const m = normalizeModel({ sources: [orders] });
    expect(m.joins).toEqual([]);
    expect(m.filters.items).toEqual([]);
    m.filters.items.push({
      id: "c",
      kind: "condition",
      source: "o",
      column: "a",
      operator: "=",
      value: { kind: "param", name: "p" },
    });
    m.having.items.push({
      id: "d",
      kind: "condition",
      source: "o",
      column: "a",
      aggregate: "sum",
      operator: ">",
      value: { kind: "param", name: "p" },
    });
    expect(builderParameterNames(m)).toEqual(["p"]);
  });
  it("picks unused aliases", () => {
    expect(aliasFor("orders", [])).toBe("o");
    expect(aliasFor("orders", ["o"])).toBe("o2");
    expect(aliasFor("123", [])).toBe("t");
  });
  it("converts run parameters to data values", () => {
    expect(toDataValue(3)).toEqual({ type: "integer", value: 3 });
    expect(toDataValue(1.5)).toEqual({ type: "real", value: 1.5 });
    expect(toDataValue(null)).toEqual({ type: "null" });
    expect(toDataValue({ type: "date", value: "2024-01-01" })).toEqual({
      type: "date",
      value: "2024-01-01",
    });
    expect(toNamedValues({ a: "x", b: false })).toEqual([
      { column: "a", value: { type: "text", value: "x" } },
      { column: "b", value: { type: "boolean", value: false } },
    ]);
  });
});
