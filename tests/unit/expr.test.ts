import { describe, expect, it } from "vitest";
import {
  check,
  evaluate,
  evaluateBoolean,
  ExprError,
  formatValue,
  parse,
  referencedNames,
} from "../../src/expr";

const ev = (src: string, scope: Record<string, unknown> = {}) => evaluate(src, scope);

function errorOf(fn: () => unknown): ExprError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ExprError) return e;
    throw e;
  }
  throw new Error("expected an ExprError");
}

describe("literals and arithmetic", () => {
  it("evaluates literals", () => {
    expect(ev("42")).toBe(42);
    expect(ev("3.25")).toBe(3.25);
    expect(ev(".5")).toBe(0.5);
    expect(ev("'it''s'")).toBe("it's");
    expect(ev('"say ""hi"""')).toBe('say "hi"');
    expect(ev("TRUE")).toBe(true);
    expect(ev("false")).toBe(false);
    expect(ev("Null")).toBeNull();
    expect(ev("#2026-01-31#")).toBe("2026-01-31");
    expect(ev("#2026-01-31T09:05:00#")).toBe("2026-01-31T09:05:00");
  });

  it("follows operator precedence", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("10 - 4 - 3")).toBe(3);
    expect(ev("2 * 3 % 4")).toBe(2);
    expect(ev("-2 * 3")).toBe(-6);
    expect(ev("- (1 + 1)")).toBe(-2);
    expect(ev("1 + 2 & 'x'")).toBe("3x");
    expect(ev("1 < 2 and 3 > 4 or true")).toBe(true);
    expect(ev("not 1 = 2")).toBe(true);
    expect(ev("not false and false")).toBe(false);
  });

  it("removes floating point noise", () => {
    expect(ev("0.1 + 0.2")).toBe(0.3);
    expect(ev("1.1 * 3")).toBe(3.3);
    expect(ev("0.3 - 0.1")).toBe(0.2);
    expect(ev("1 / 3")).toBe(0.333333333333333);
    expect(ev("round(1.005, 2)")).toBe(1.01);
    expect(ev("round(-2.5)")).toBe(-3);
  });

  it("returns null when dividing by zero", () => {
    expect(ev("1 / 0")).toBeNull();
    expect(ev("5 % 0")).toBeNull();
  });
});

describe("names", () => {
  const scope = {
    record: { amount: 12.5, "Unit Price": 3, customer: { name: "Ada" } },
    form: { status: "open" },
    params: { from: "2026-01-01" },
    app: { user: { email: "a@b.c" } },
  };

  it("reads dotted and bracketed paths", () => {
    expect(ev("record.amount * 2", scope)).toBe(25);
    expect(ev("record.[Unit Price] * 2", scope)).toBe(6);
    expect(ev("record.customer.name", scope)).toBe("Ada");
    expect(ev("form.status = 'open'", scope)).toBe(true);
    expect(ev("app.user.email", scope)).toBe("a@b.c");
    expect(ev("[Total Due] + 1", { "Total Due": 4 })).toBe(5);
  });

  it("gives null for missing fields and an error for unknown roots", () => {
    expect(ev("record.missing", scope)).toBeNull();
    expect(ev("record.customer.missing.deeper", scope)).toBeNull();
    const err = errorOf(() => ev("1 + nope", scope));
    expect(err.message).toBe("Unknown name 'nope'");
    expect([err.start, err.end]).toEqual([4, 8]);
  });

  it("converts host values", () => {
    expect(ev("d", { d: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) })).toBe("2026-01-02T03:04:05");
    expect(ev("u", { u: undefined })).toBeNull();
    expect(ev("b + 1", { b: 2n })).toBe(3);
  });
});

describe("null semantics", () => {
  it("propagates null through arithmetic and comparisons", () => {
    expect(ev("null + 1")).toBeNull();
    expect(ev("-null")).toBeNull();
    expect(ev("null = null")).toBeNull();
    expect(ev("null <> 1")).toBeNull();
    expect(ev("not null")).toBeNull();
  });

  it("treats null as empty text when joining", () => {
    expect(ev("'a' & null & 'b'")).toBe("ab");
    expect(ev("concat('a', null, 1)")).toBe("a1");
  });

  it("uses three-valued and/or", () => {
    expect(ev("null and false")).toBe(false);
    expect(ev("null and true")).toBeNull();
    expect(ev("null or true")).toBe(true);
    expect(ev("null or false")).toBeNull();
    expect(ev("false and (1 / 'x' = 1)")).toBe(false);
  });

  it("supports is null, in and between", () => {
    expect(ev("x is null", { x: null })).toBe(true);
    expect(ev("x IS NOT NULL", { x: 0 })).toBe(true);
    expect(ev("2 in (1, 2, 3)")).toBe(true);
    expect(ev("5 in (1, 2)")).toBe(false);
    expect(ev("5 not in (1, 2)")).toBe(true);
    expect(ev("5 in (1, null)")).toBeNull();
    expect(ev("'b' in (list)", { list: ["a", "b"] })).toBe(true);
    expect(ev("5 between 1 and 5")).toBe(true);
    expect(ev("6 not between 1 and 5")).toBe(true);
    expect(ev("x between 1 and 5 and true", { x: 3 })).toBe(true);
    expect(ev("null between 1 and 2")).toBeNull();
  });

  it("evaluateBoolean maps null to false and rejects other types", () => {
    expect(evaluateBoolean("null = 1")).toBe(false);
    expect(evaluateBoolean("record.amount > 10", { record: { amount: 11 } })).toBe(true);
    expect(() => evaluateBoolean("1 + 1")).toThrow("Expected true or false but got number");
  });
});

describe("comparisons", () => {
  it("compares numbers, text, booleans and dates", () => {
    expect(ev("2 >= 2")).toBe(true);
    expect(ev("'abc' < 'abd'")).toBe(true);
    expect(ev("'A' = 'a'")).toBe(false);
    expect(ev("1 == 1 && 2 != 3")).toBe(true);
    expect(ev("#2026-01-31# = '2026-01-31T00:00:00'")).toBe(true);
    expect(ev("#2026-02-01# > #2026-01-31T23:59:59#")).toBe(true);
    expect(ev("1 = '1'")).toBe(false);
    expect(ev("!(1 = 1) || false")).toBe(false);
  });

  it("rejects ordering across types and chained comparisons", () => {
    expect(() => ev("1 < 'a'")).toThrow("Can't compare number with text");
    const err = errorOf(() => parse("1 < 2 < 3"));
    expect(err.message).toMatch(/can't be chained/);
    expect(err.start).toBe(6);
  });
});

describe("functions", () => {
  it("handles text", () => {
    expect(ev("len('héllo')")).toBe(5);
    expect(ev("UPPER('ab') & lower('CD')")).toBe("ABcd");
    expect(ev("trim('  x ')")).toBe("x");
    expect(ev("left('abcdef', 2)")).toBe("ab");
    expect(ev("right('abcdef', 3)")).toBe("def");
    expect(ev("mid('abcdef', 2, 3)")).toBe("bcd");
    expect(ev("substr('abcdef', 4)")).toBe("def");
    expect(ev("contains('Hello World', 'world')")).toBe(true);
    expect(ev("startswith('Hello', 'he')")).toBe(true);
    expect(ev("endswith('Hello', 'x')")).toBe(false);
    expect(ev("replace('a-b-c', '-', '+')")).toBe("a+b+c");
    expect(ev("len(null)")).toBeNull();
  });

  it("handles conditionals and nulls", () => {
    expect(ev("if(1 > 0, 'yes', 'no')")).toBe("yes");
    expect(ev("IF(null, 'yes', 'no')")).toBe("no");
    expect(ev("if(false, 1)")).toBeNull();
    expect(ev("if(true, 1, 1 / 'x')")).toBe(1);
    expect(ev("coalesce(null, null, 3)")).toBe(3);
    expect(ev("nz(x, 0)", { x: null })).toBe(0);
    expect(ev("isnull(null)")).toBe(true);
    expect(ev("isblank('  ')")).toBe(true);
    expect(ev("isblank('a')")).toBe(false);
  });

  it("handles numbers", () => {
    expect(ev("round(2.345, 2)")).toBe(2.35);
    expect(ev("round(1234, -2)")).toBe(1200);
    expect(ev("floor(2.7)")).toBe(2);
    expect(ev("ceil(2.1)")).toBe(3);
    expect(ev("floor(2.789, 1)")).toBe(2.7);
    expect(ev("abs(-4)")).toBe(4);
    expect(ev("min(3, 1, 2)")).toBe(1);
    expect(ev("max(3, null, 7)")).toBe(7);
    expect(ev("max('2026-01-01', '2026-03-01')")).toBe("2026-03-01");
    expect(ev("number(' 1,234.5 ')")).toBe(1234.5);
    expect(ev("number('abc')")).toBeNull();
    expect(ev("number(true)")).toBe(1);
    expect(ev("text(1.5) & '!'")).toBe("1.5!");
  });

  it("validates regex patterns safely", () => {
    expect(ev("regexmatch('AB-123', '^[A-Z]{2}-\\d+$')")).toBe(true);
    expect(ev("regexmatch('x', '^\\d+$')")).toBe(false);
    expect(() => ev("regexmatch('aaaa', '(a+)+$')")).toThrow(/nested repetition/);
    expect(() => ev("regexmatch('aa', '(a)\\1')")).toThrow(/back-references/);
    expect(() => ev("regexmatch('a', '(')")).toThrow(/invalid pattern/);
    expect(ev("regexmatch('ab', '(?:ab)+')")).toBe(true);
  });
});

describe("aggregates", () => {
  const rows = [
    { amount: 10, qty: 2, price: 1.1, paid: true },
    { amount: 2.5, qty: 1, price: 0.2, paid: false },
    { amount: null, qty: 3, price: 0.1, paid: true },
  ];

  it("aggregates projected fields", () => {
    expect(ev("sum(rows.amount)", { rows })).toBe(12.5);
    expect(ev("avg(rows.amount)", { rows })).toBe(6.25);
    expect(ev("count(rows.amount)", { rows })).toBe(2);
    expect(ev("count(rows)", { rows })).toBe(3);
    expect(ev("max(rows.qty)", { rows })).toBe(3);
    expect(ev("sum(1, 2, 3)")).toBe(6);
    expect(ev("sum(empty.amount)", { empty: [] })).toBe(0);
    expect(ev("avg(empty.amount)", { empty: [] })).toBeNull();
  });

  it("evaluates an expression per item", () => {
    expect(ev("sumof(rows, qty * price)", { rows })).toBe(2.7);
    expect(ev("countof(rows, paid)", { rows })).toBe(2);
    expect(ev("maxof(rows, item.qty * 10)", { rows })).toBe(30);
    expect(ev("sumof(rows, qty * rate)", { rows, rate: 2 })).toBe(12);
    expect(() => ev("sumof(5, 1)")).toThrow("sumof: expected a list but got number");
  });
});

describe("dates", () => {
  const now = new Date(Date.UTC(2026, 9, 3, 14, 30, 15));
  const at = (src: string, scope: Record<string, unknown> = {}) => evaluate(src, scope, { now });

  it("uses the injected clock in UTC", () => {
    expect(at("today()")).toBe("2026-10-03");
    expect(at("now()")).toBe("2026-10-03T14:30:15");
    expect(at("year(today()) * 100 + month(today())")).toBe(202610);
  });

  it("builds and splits dates", () => {
    expect(ev("date(2026, 2, 28)")).toBe("2026-02-28");
    expect(ev("date(2026, 13, 1)")).toBe("2027-01-01");
    expect(ev("day(#2026-01-31#)")).toBe(31);
    expect(ev("hour('2026-01-31T10:20:00Z')")).toBe(10);
    expect(ev("weekday(#2026-10-03#)")).toBe(7);
    expect(() => ev("year('soon')")).toThrow('year: expected a date but got "soon"');
  });

  it("adds and diffs dates", () => {
    expect(ev("dateadd('day', 1, #2026-12-31#)")).toBe("2027-01-01");
    expect(ev("dateadd('month', 1, #2026-01-31#)")).toBe("2026-02-28");
    expect(ev("dateadd('year', 1, #2024-02-29#)")).toBe("2025-02-28");
    expect(ev("dateadd('hour', 2, #2026-01-01#)")).toBe("2026-01-01T02:00:00");
    expect(ev("dateadd('m', -2, #2026-01-15T08:00:00#)")).toBe("2025-11-15T08:00:00");
    expect(ev("datediff('day', #2026-01-01#, #2026-03-01#)")).toBe(59);
    expect(ev("datediff('month', #2026-01-31#, #2026-02-01#)")).toBe(1);
    expect(ev("datediff('year', #2025-12-31#, #2026-01-01#)")).toBe(1);
    expect(ev("datediff('week', #2026-01-01#, #2026-01-20#)")).toBe(2);
    expect(ev("datediff('minute', #2026-01-01T10:00:00#, #2026-01-01T11:30:00#)")).toBe(90);
    expect(ev("datediff('day', null, #2026-01-01#)")).toBeNull();
  });

  it("rejects impossible date literals", () => {
    const err = errorOf(() => parse("x > #2026-02-30#"));
    expect(err.message).toMatch(/Invalid date '2026-02-30'/);
    expect([err.start, err.end]).toEqual([4, 16]);
  });
});

describe("formatting", () => {
  it("formats numbers", () => {
    expect(ev("format(1234.5, '#,##0.00')")).toBe("1,234.50");
    expect(ev("format(1234.5, '0.00')")).toBe("1234.50");
    expect(ev("format(0.256, '0%')")).toBe("26%");
    expect(ev("format(0.2567, '0.0%')")).toBe("25.7%");
    expect(ev("format(-1234567.891, '$#,##0.00')")).toBe("-$1,234,567.89");
    expect(ev("format(3.1, '0.##')")).toBe("3.1");
    expect(ev("format(7, '000')")).toBe("007");
    expect(ev("format(1.005, '0.00')")).toBe("1.01");
    expect(ev("format(null, '0.00')")).toBeNull();
  });

  it("formats dates", () => {
    expect(ev("format(#2026-01-05#, 'yyyy-MM-dd')")).toBe("2026-01-05");
    expect(ev("format(#2026-01-05#, 'dd/MM/yyyy')")).toBe("05/01/2026");
    expect(ev("format(#2026-01-05#, 'MMM d, yyyy')")).toBe("Jan 5, 2026");
    expect(ev("format(#2026-01-05T15:07:00#, 'dddd h:mm tt')")).toBe("Monday 3:07 PM");
    expect(ev("text(#2026-01-05#, 'MMMM yyyy')")).toBe("January 2026");
  });

  it("formatValue formats host values", () => {
    expect(formatValue(1234.567, "#,##0.0")).toBe("1,234.6");
    expect(formatValue(null, "0.00")).toBe("");
    expect(formatValue(0.1 + 0.2)).toBe("0.3");
    expect(formatValue("2026-03-04", "d MMM yyyy")).toBe("4 Mar 2026");
    expect(() => formatValue(true, "0.00")).toThrow();
  });
});

describe("errors", () => {
  it("reports syntax errors with positions", () => {
    const cases: [string, string, number, number][] = [
      ["1 +", "Unexpected end of expression", 3, 3],
      ["(1 + 2", "Expected ')' but the expression ended", 6, 6],
      ["'abc", "Unterminated string", 0, 4],
      ["1 @ 2", "Unexpected character '@'", 2, 3],
      ["x is 3", "Expected 'null' after 'is'", 5, 6],
      ["", "Expression is empty", 0, 0],
      ["a b", "Unexpected 'b'", 2, 3],
    ];
    for (const [src, message, start, end] of cases) {
      const err = errorOf(() => parse(src));
      expect({ src, message: err.message, start: err.start, end: err.end }).toEqual({
        src,
        message,
        start,
        end,
      });
    }
  });

  it("reports type errors with positions", () => {
    const err = errorOf(() => ev("1 + ('a' + 2)"));
    expect(err.message).toBe("Can't add text and number; use & to join text");
    expect([err.start, err.end]).toEqual([4, 13]);
    const fnErr = errorOf(() => ev("round('x')"));
    expect(fnErr.message).toBe("round: expected a number but got text");
    expect(fnErr.start).toBe(6);
    expect(errorOf(() => ev("frob(1)")).end).toBe(4);
  });

  it("limits nesting depth", () => {
    expect(() => parse(`${"(".repeat(200)}1${")".repeat(200)}`)).toThrow(/nested too deeply/);
  });
});

describe("injection attempts", () => {
  it("blocks prototype names at parse time", () => {
    expect(() => parse("constructor")).toThrow("The name 'constructor' is not allowed");
    expect(() => parse("record.__proto__")).toThrow("The name '__proto__' is not allowed");
    expect(() => parse("record.[constructor].name")).toThrow(/not allowed/);
    expect(() => parse("x.prototype")).toThrow(/not allowed/);
  });

  it("never reads inherited properties or calls host functions", () => {
    const record = Object.create({ secret: "inherited" }) as Record<string, unknown>;
    record.own = 1;
    expect(ev("record.secret", { record })).toBeNull();
    expect(ev("record.toString", { record })).toBeNull();
    expect(ev("record.own", { record })).toBe(1);
    expect(() => ev("toString", {})).toThrow("Unknown name 'toString'");
    expect(ev("fn", { fn: () => "pwned" })).toBeNull();
    expect(() => ev("valueOf()")).toThrow("Unknown function 'valueof'");
    expect(() => ev("hasOwnProperty('x')")).toThrow(/Unknown function/);
    expect(() => ev("x.length", { x: "abc" })).toThrow("Can't read 'length' from text");
  });
});

describe("check", () => {
  it("returns no diagnostics for a valid expression", () => {
    expect(check("record.amount > 0 and contains(record.name, 'x')", ["record"])).toEqual([]);
  });

  it("reports syntax, function and arity errors", () => {
    expect(check("1 +")).toEqual([
      { severity: "error", message: "Unexpected end of expression", start: 3, end: 3 },
    ]);
    expect(check("foo(1) + left()").map((d) => d.message)).toEqual([
      "Unknown function 'foo'",
      "left() takes 1 to 2 arguments but got 0",
    ]);
    expect(check("today(1)")[0].message).toBe("today() takes 0 arguments but got 1");
    expect(check("if(a)")[0].message).toBe("if() takes 2 to 3 arguments but got 1");
  });

  it("checks names against knownNames", () => {
    const known = ["record", "params.from"];
    expect(check("record.x + params.from", known)).toEqual([]);
    expect(check("params.to", known)[0].message).toBe("Unknown field 'params.to'");
    const [diag] = check("1 + recrod.amount", known);
    expect(diag).toEqual({
      severity: "error",
      message: "Unknown name 'recrod'",
      start: 4,
      end: 17,
    });
    expect(check("sumof(record.lines, qty * price)", known)).toEqual([]);
    expect(check("anything")).toEqual([]);
  });

  it("validates literal units, patterns and constant expressions", () => {
    expect(check("dateadd('fortnight', 1, today())")[0].message).toBe(
      "Unknown date unit 'fortnight'",
    );
    expect(check("regexmatch(x, '(a*)*')")[0].message).toMatch(/nested repetition/);
    expect(check("1 + 'a'")[0].message).toMatch(/Can't add number and text/);
  });
});

describe("referencedNames", () => {
  it("lists dotted names once in order", () => {
    expect(referencedNames("record.a + record.[B c] + record.a * params.x")).toEqual([
      "record.a",
      "record.B c",
      "params.x",
    ]);
    expect(referencedNames("sumof(rows, qty * price) + tax")).toEqual(["rows", "tax"]);
    expect(referencedNames("1 + 2")).toEqual([]);
  });

  it("caches parsed expressions", () => {
    expect(parse("1 + 1")).toBe(parse("1 + 1"));
  });
});
