import { describe, expect, it } from "vitest";
import {
  type ConditionalStyle,
  filterNames,
  pageLabel,
  rowFilter,
  SCAN_BUDGET,
  SCAN_LIMIT,
  scanFiltered,
  toneClass,
  toneFor,
} from "../../src/runtime/conditions";
import { check } from "../../src/expr";

const rule = (when: string, tone: ConditionalStyle["tone"], column?: string): ConditionalStyle => ({
  id: when,
  when,
  tone,
  column,
});

describe("toneFor", () => {
  const rules = [
    rule("value < 0", "negative"),
    rule("value > 100", "positive"),
    rule("true", "muted"),
  ];

  it("returns the first matching rule's tone", () => {
    expect(toneFor(rules, { value: -5 })).toBe("negative");
    expect(toneFor(rules, { value: 500 })).toBe("positive");
    expect(toneFor(rules, { value: 50 })).toBe("muted");
    expect(toneFor([], { value: 1 })).toBeNull();
    expect(toneFor(undefined, { value: 1 })).toBeNull();
  });

  it("skips blank, invalid, null, and non-boolean conditions", () => {
    const odd = [rule("", "warning"), rule("value >", "warning"), rule("value", "warning")];
    expect(toneFor(odd, { value: 3 })).toBeNull();
    expect(toneFor([rule("value > 1", "warning")], { value: null })).toBeNull();
  });

  it("limits rules to a column when one is given", () => {
    const table = [rule("value > 1", "warning", "a"), rule("value > 1", "emphasis", "b")];
    expect(toneFor(table, { value: 5 }, "b")).toBe("emphasis");
    expect(toneFor(table, { value: 5 }, "c")).toBeNull();
  });

  it("can read the whole row", () => {
    const scope = { record: { status: "late" }, value: 3 };
    expect(toneFor([rule("record.status = 'late'", "negative")], scope)).toBe("negative");
  });

  it("maps tones to classes", () => {
    expect(toneClass("negative")).toBe("tone tone-negative");
    expect(toneClass(null)).toBe("");
  });
});

describe("rowFilter", () => {
  it("is null for a blank filter and throws on a syntax error", () => {
    expect(rowFilter("", {})).toBeNull();
    expect(rowFilter("  ", {})).toBeNull();
    expect(() => rowFilter("record.qty >", {})).toThrow();
  });

  it("evaluates against the row and the other scope roots", () => {
    const keep = rowFilter("record.qty > params.min and record.region = parent.region", {
      params: { min: 1 },
      parent: { region: "East" },
    });
    expect(keep?.({ qty: 2, region: "East" })).toBe(true);
    expect(keep?.({ qty: 2, region: "West" })).toBe(false);
    expect(keep?.({ qty: 0, region: "East" })).toBe(false);
  });

  it("excludes rows whose evaluation is null or fails", () => {
    const keep = rowFilter("record.qty > 1", {});
    expect(keep?.({ qty: null })).toBe(false);
    expect(rowFilter("record.name + 1 > 0", {})?.({ name: "x" })).toBe(false);
  });

  it("knows the filter scope names", () => {
    const names = filterNames(["qty"]);
    expect(check("record.qty > 0 and parent.id = app.user.id", names)).toEqual([]);
    expect(check("record.bogus > 0", names)[0].message).toMatch(/Unknown field/);
    expect(check("other > 0", names)[0].message).toMatch(/Unknown name/);
  });
});

function source(size: number) {
  const reads: number[] = [];
  const fetch = async (offset: number, limit: number) => {
    const rows = Array.from({ length: Math.max(0, Math.min(limit, size - offset)) }, (_, i) => ({
      n: offset + i,
    }));
    reads.push(rows.length);
    return rows;
  };
  return { fetch, reads };
}

describe("scanFiltered", () => {
  it("scans a small source to the end and reports an exact total", async () => {
    const { fetch } = source(1200);
    const scan = await scanFiltered(fetch, (row) => row.n % 3 === 0, 26);
    expect(scan.exhausted).toBe(true);
    expect(scan.matches).toHaveLength(400);
  });

  it("stops after the budget once a full page plus one is found, giving a lower bound", async () => {
    const { fetch, reads } = source(100_000);
    const scan = await scanFiltered(fetch, (row) => row.n % 2 === 0, 26);
    expect(scan.exhausted).toBe(false);
    expect(reads.reduce((a, b) => a + b, 0)).toBe(SCAN_BUDGET);
    expect(scan.matches).toHaveLength(SCAN_BUDGET / 2);
  });

  it("keeps scanning past the budget for a deep page, but never past the hard limit", async () => {
    const deep = source(100_000);
    const scan = await scanFiltered(deep.fetch, (row) => row.n % 100 === 0, 76);
    expect(scan.matches.length).toBeGreaterThanOrEqual(76);
    expect(scan.exhausted).toBe(false);
    const sparse = source(1_000_000);
    const none = await scanFiltered(sparse.fetch, () => false, 1);
    expect(none).toEqual({ matches: [], exhausted: false });
    expect(sparse.reads.reduce((a, b) => a + b, 0)).toBe(SCAN_LIMIT);
  });

  it("stops as soon as enough matches are found when no minimum scan is asked for", async () => {
    const { fetch, reads } = source(100_000);
    const scan = await scanFiltered(fetch, () => true, 50, { minScan: 0 });
    expect(reads).toEqual([500]);
    expect(scan.matches.length).toBeGreaterThanOrEqual(50);
  });
});

describe("pageLabel", () => {
  it("says when a filtered total is only a lower bound", () => {
    expect(pageLabel(0, 25, 40, true)).toBe("1–25 of 40");
    expect(pageLabel(25, 15, 40, true)).toBe("26–40 of 40");
    expect(pageLabel(0, 25, 2500, false)).toBe("1–25 of at least 2500");
    expect(pageLabel(0, 0, 0, true)).toBe("0 records");
  });
});
