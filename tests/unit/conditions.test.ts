import { describe, expect, it } from "vitest";
import {
  type ConditionalStyle,
  filterNames,
  filterInputs,
  filterInputsKey,
  pageLabel,
  pagedScan,
  rowFilter,
  SCAN_LIMIT,
  scanFiltered,
  TRUNCATED_NOTICE,
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
  it("scans a small source to the end", async () => {
    const { fetch } = source(1200);
    const scan = await scanFiltered(fetch, (row) => row.n % 3 === 0, 1000);
    expect(scan.exhausted).toBe(true);
    expect(scan.matches).toHaveLength(400);
  });

  it("stops as soon as enough matches are found, but never past the hard limit", async () => {
    const { fetch, reads } = source(100_000);
    const scan = await scanFiltered(fetch, () => true, 50);
    expect(reads).toEqual([500]);
    expect(scan.matches.length).toBeGreaterThanOrEqual(50);
    const sparse = source(1_000_000);
    const none = await scanFiltered(sparse.fetch, () => false, 1);
    expect(none).toEqual({ matches: [], exhausted: false });
    expect(sparse.reads.reduce((a, b) => a + b, 0)).toBe(SCAN_LIMIT);
  });
});

describe("pagedScan", () => {
  it("keeps every match of a source below the limit", async () => {
    const { fetch } = source(12_000);
    const scan = await pagedScan(fetch, (row) => row.n % 1000 === 7);
    expect(scan.truncated).toBe(false);
    expect(scan.matches.map((row) => row.n)).toEqual(
      Array.from({ length: 12 }, (_, i) => i * 1000 + 7),
    );
  });

  it("reports truncation when the source is larger than the limit", async () => {
    const { fetch, reads } = source(SCAN_LIMIT * 2);
    const scan = await pagedScan(fetch, (row) => row.n % 10_000 === 0);
    expect(scan.truncated).toBe(true);
    expect(scan.matches).toHaveLength(SCAN_LIMIT / 10_000);
    expect(reads.reduce((a, b) => a + b, 0)).toBe(SCAN_LIMIT);
    expect(TRUNCATED_NOTICE).toBe(
      "Filter applied to the first 50,000 rows; some matches may be missing.",
    );
  });
});

describe("pageLabel", () => {
  it("shows the range and the total", () => {
    expect(pageLabel(0, 25, 40)).toBe("1–25 of 40");
    expect(pageLabel(25, 15, 40)).toBe("26–40 of 40");
    expect(pageLabel(0, 0, 0)).toBe("0 records");
  });
});

describe("filterInputs", () => {
  const scope = {
    parent: { id: 4, status: "open", notes: "long text" },
    form: { min: 3, other: "x" },
    app: { user: { id: 9, name: "Ann" } },
    params: {},
  };

  it("keeps only the referenced values, never the row", () => {
    expect(
      filterInputs(
        "record.qty > form.min and record.owner = app.user.id and parent.status = 'open'",
        scope,
      ),
    ).toEqual({ form: { min: 3 }, app: { user: { id: 9 } }, parent: { status: "open" } });
  });

  it("copies a whole root when the filter uses it whole", () => {
    expect(filterInputs("not isnull(parent) and parent.id > 0", scope)).toEqual({
      parent: scope.parent,
    });
  });

  it("copies a null or missing value where the path stops", () => {
    expect(filterInputs("parent.id > 0", { parent: null })).toEqual({ parent: null });
    expect(filterInputs("form.nope > 0", scope)).toEqual({ form: {} });
  });

  it("gives a key that changes only with referenced values", () => {
    const src = "record.qty > form.min";
    const key = filterInputsKey(src, scope);
    expect(filterInputsKey(src, { ...scope, form: { min: 3, other: "y" } })).toBe(key);
    expect(filterInputsKey(src, { ...scope, form: { min: 4, other: "x" } })).not.toBe(key);
    expect(filterInputsKey("", scope)).toBe("");
    expect(filterInputsKey("record.qty >", scope)).toBe(JSON.stringify(["record.qty >", {}]));
  });
});
