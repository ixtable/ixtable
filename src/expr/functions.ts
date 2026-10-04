import { type Ast, type AstOf, errorAt } from "./ast";
import { FormatError, formatValue } from "./format";
import {
  compareValues,
  formatIsoDate,
  formatIsoDateTime,
  fromHost,
  normalizeNumber,
  parseIsoDate,
  roundTo,
  toText,
  typeName,
  utc,
  type Value,
} from "./values";

/** Lazily evaluated arguments of one function call. */
export interface Call {
  node: AstOf<"call">;
  count: number;
  arg(i: number): Value;
  argForItem(i: number, item: unknown): Value;
  now(): Date;
}

interface FnDef {
  min: number;
  max: number;
  /** Index of the argument evaluated once per list item (`sumof(rows, qty * price)`). */
  perItemArg?: number;
  impl(c: Call): Value;
}

function argNode(c: Call, i: number): Ast {
  return c.node.args[i] ?? c.node;
}

function fail(c: Call, i: number, message: string): never {
  throw errorAt(argNode(c, i), `${c.node.name}: ${message}`);
}

function num(c: Call, i: number): number | null {
  const v = c.arg(i);
  if (v === null || typeof v === "number") return v;
  return fail(c, i, `expected a number but got ${typeName(v)}`);
}

function int(c: Call, i: number, fallback?: number): number | null {
  if (i >= c.count && fallback !== undefined) return fallback;
  const v = num(c, i);
  if (v !== null && !Number.isInteger(v)) fail(c, i, `expected a whole number but got ${v}`);
  return v;
}

function text(c: Call, i: number): string | null {
  const v = c.arg(i);
  if (v === null) return null;
  if (typeof v === "object") return fail(c, i, `expected text but got ${typeName(v)}`);
  return toText(v);
}

function date(c: Call, i: number): { ms: number; hasTime: boolean } | null {
  const v = c.arg(i);
  if (v === null) return null;
  const parsed = typeof v === "string" ? parseIsoDate(v) : null;
  if (!parsed) fail(c, i, `expected a date but got ${JSON.stringify(v)}`);
  return parsed;
}

function flatten(values: Value[], out: Value[] = []): Value[] {
  for (const v of values) {
    if (Array.isArray(v)) flatten(v.map(fromHost), out);
    else out.push(v);
  }
  return out;
}

function allArgs(c: Call): Value[] {
  return Array.from({ length: c.count }, (_, i) => c.arg(i));
}

function numbers(c: Call, values: Value[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (v === null) continue;
    if (typeof v !== "number") fail(c, 0, `expected numbers but got ${typeName(v)}`);
    out.push(v);
  }
  return out;
}

function sumOf(values: number[]): number {
  return values.reduce((acc, n) => normalizeNumber(acc + n), 0);
}

function extreme(c: Call, values: Value[], sign: 1 | -1): Value {
  let best: Value = null;
  for (const v of values) {
    if (v === null) continue;
    if (typeof v === "object") fail(c, 0, `can't compare ${typeName(v)} values`);
    if (best === null) {
      best = v;
      continue;
    }
    const cmp = compareValues(v, best);
    if (cmp === undefined) fail(c, 0, `can't compare ${typeName(v)} with ${typeName(best)}`);
    if (cmp * sign > 0) best = v;
  }
  return best;
}

function listArg(c: Call): unknown[] | null {
  const list = c.arg(0);
  if (list === null) return null;
  if (!Array.isArray(list)) fail(c, 0, `expected a list but got ${typeName(list)}`);
  return list;
}

function perItem(c: Call): Value[] | null {
  const list = listArg(c);
  return list && list.map((item) => c.argForItem(1, item));
}

type Unit = "year" | "month" | "week" | "day" | "hour" | "minute" | "second";

const UNIT_ALIASES: Record<string, Unit> = {};
for (const [unit, aliases] of Object.entries({
  year: ["year", "years", "yyyy", "yy", "y"],
  month: ["month", "months", "mm", "m"],
  week: ["week", "weeks", "ww", "wk", "w"],
  day: ["day", "days", "dd", "d"],
  hour: ["hour", "hours", "hh", "h"],
  minute: ["minute", "minutes", "mi", "n"],
  second: ["second", "seconds", "ss", "s"],
})) {
  for (const alias of aliases) UNIT_ALIASES[alias] = unit as Unit;
}

export function parseUnit(raw: string): Unit | undefined {
  const key = raw.trim().toLowerCase();
  return Object.hasOwn(UNIT_ALIASES, key) ? UNIT_ALIASES[key] : undefined;
}

function unitArg(c: Call): Unit | null {
  const raw = text(c, 0);
  if (raw === null) return null;
  return (
    parseUnit(raw) ??
    fail(c, 0, `unknown unit '${raw}' (use year, month, week, day, hour, minute or second)`)
  );
}

const MS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };

function dateDiff(unit: Unit, a: number, b: number): number {
  const da = new Date(a);
  const db = new Date(b);
  const months =
    (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + db.getUTCMonth() - da.getUTCMonth();
  switch (unit) {
    case "year":
      return db.getUTCFullYear() - da.getUTCFullYear();
    case "month":
      return months;
    case "week":
      return Math.trunc(dateDiff("day", a, b) / 7);
    default: {
      const size = MS[unit];
      return Math.floor(b / size) - Math.floor(a / size);
    }
  }
}

function dateAdd(unit: Unit, n: number, ms: number): number {
  if (unit === "year" || unit === "month") {
    const d = new Date(ms);
    const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + (unit === "year" ? n * 12 : n);
    const year = Math.floor(total / 12);
    const month = total - year * 12;
    const lastDay = new Date(utc(year, month + 1, 0)).getUTCDate();
    const day = Math.min(d.getUTCDate(), lastDay);
    return utc(year, month, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  }
  if (unit === "week") return ms + n * 7 * MS.day;
  return ms + n * MS[unit];
}

const MAX_REGEX_LENGTH = 200;
const MAX_REGEX_INPUT = 10_000;
const regexCache = new Map<string, RegExp>();

/**
 * Compiles a user-supplied regular expression, rejecting patterns that can
 * backtrack catastrophically: back-references and a quantified group that
 * already contains a quantifier, such as `(a+)+`.
 */
export function compileSafeRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  if (pattern.length > MAX_REGEX_LENGTH) {
    throw new Error(`pattern is longer than ${MAX_REGEX_LENGTH} characters`);
  }
  if (/\\[1-9]|\\k</.test(pattern)) throw new Error("back-references are not allowed");
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "(") {
      stack.push(false);
      if (pattern[i + 1] === "?") {
        i++;
        if (pattern[i + 1] === "<" && !/[=!]/.test(pattern[i + 2] ?? "")) {
          i = pattern.indexOf(">", i);
          if (i < 0) break;
        } else if (/[:=!<]/.test(pattern[i + 1] ?? "")) {
          i += pattern[i + 1] === "<" ? 2 : 1;
        }
      }
    } else if (ch === ")") {
      const inner = stack.pop() ?? false;
      const next = pattern[i + 1] ?? "";
      if (inner && /[+*{]/.test(next)) {
        throw new Error("nested repetition like (a+)+ is not allowed");
      }
      if (stack.length && (inner || /[+*?{]/.test(next))) stack[stack.length - 1] = true;
    } else if (/[+*?{]/.test(ch) && stack.length) {
      stack[stack.length - 1] = true;
    }
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, "u");
  } catch (e) {
    throw new Error(`invalid pattern: ${(e as Error).message}`, { cause: e });
  }
  if (regexCache.size > 200) regexCache.clear();
  regexCache.set(pattern, re);
  return re;
}

const fns = new Map<string, FnDef>();

function define(
  names: string[],
  min: number,
  max: number,
  impl: (c: Call) => Value,
  perItemArg?: number,
) {
  for (const name of names) fns.set(name, { min, max, impl, perItemArg });
}

const stringFn = (fn: (s: string, c: Call) => Value) => (c: Call) => {
  const s = text(c, 0);
  return s === null ? null : fn(s, c);
};

define(["if", "iif"], 2, 3, (c) => {
  const cond = c.arg(0);
  if (cond !== null && typeof cond !== "boolean") {
    fail(c, 0, `condition must be true or false but got ${typeName(cond)}`);
  }
  if (cond === true) return c.arg(1);
  return c.count > 2 ? c.arg(2) : null;
});
define(["coalesce", "nz"], 1, Infinity, (c) => {
  for (let i = 0; i < c.count; i++) {
    const v = c.arg(i);
    if (v !== null) return v;
  }
  return null;
});
define(["isnull"], 1, 1, (c) => c.arg(0) === null);
define(["isblank"], 1, 1, (c) => {
  const v = c.arg(0);
  return v === null || (typeof v === "string" && v.trim() === "");
});

define(
  ["len"],
  1,
  1,
  stringFn((s) => Array.from(s).length),
);
define(
  ["lower"],
  1,
  1,
  stringFn((s) => s.toLowerCase()),
);
define(
  ["upper"],
  1,
  1,
  stringFn((s) => s.toUpperCase()),
);
define(
  ["trim"],
  1,
  1,
  stringFn((s) => s.trim()),
);
define(
  ["left"],
  1,
  2,
  stringFn((s, c) => {
    const n = int(c, 1, 1);
    if (n === null) return null;
    if (n < 0) fail(c, 1, "count can't be negative");
    return Array.from(s).slice(0, n).join("");
  }),
);
define(
  ["right"],
  1,
  2,
  stringFn((s, c) => {
    const n = int(c, 1, 1);
    if (n === null) return null;
    if (n < 0) fail(c, 1, "count can't be negative");
    return n === 0 ? "" : Array.from(s).slice(-n).join("");
  }),
);
define(
  ["mid", "substr"],
  2,
  3,
  stringFn((s, c) => {
    const start = int(c, 1);
    const length = int(c, 2, Infinity);
    if (start === null || length === null) return null;
    if (start < 1) fail(c, 1, "start position begins at 1");
    if (length < 0) fail(c, 2, "length can't be negative");
    const chars = Array.from(s);
    return chars.slice(start - 1, start - 1 + Math.min(length, chars.length)).join("");
  }),
);
define(["concat"], 1, Infinity, (c) =>
  Array.from({ length: c.count }, (_, i) => text(c, i) ?? "").join(""),
);
const caseless = (fn: (s: string, sub: string) => boolean) =>
  stringFn((s, c) => {
    const sub = text(c, 1);
    return sub === null ? null : fn(s.toLowerCase(), sub.toLowerCase());
  });
define(
  ["contains"],
  2,
  2,
  caseless((s, sub) => s.includes(sub)),
);
define(
  ["startswith"],
  2,
  2,
  caseless((s, sub) => s.startsWith(sub)),
);
define(
  ["endswith"],
  2,
  2,
  caseless((s, sub) => s.endsWith(sub)),
);
define(
  ["replace"],
  3,
  3,
  stringFn((s, c) => {
    const find = text(c, 1);
    const replacement = text(c, 2);
    if (find === null || replacement === null) return null;
    return find === "" ? s : s.split(find).join(replacement);
  }),
);
define(
  ["regexmatch"],
  2,
  2,
  stringFn((s, c) => {
    const pattern = text(c, 1);
    if (pattern === null) return null;
    if (s.length > MAX_REGEX_INPUT) fail(c, 0, `text is longer than ${MAX_REGEX_INPUT} characters`);
    try {
      return compileSafeRegex(pattern).test(s);
    } catch (e) {
      return fail(c, 1, (e as Error).message);
    }
  }),
);

const rounding = (op: (n: number) => number) => (c: Call) => {
  const n = num(c, 0);
  const digits = int(c, 1, 0);
  if (n === null || digits === null) return null;
  if (op === Math.round) return roundTo(n, digits);
  const scale = 10 ** digits;
  return normalizeNumber(op(normalizeNumber(n * scale)) / scale);
};
define(["round"], 1, 2, rounding(Math.round));
define(["floor"], 1, 2, rounding(Math.floor));
define(["ceil", "ceiling"], 1, 2, rounding(Math.ceil));
define(["abs"], 1, 1, (c) => {
  const n = num(c, 0);
  return n === null ? null : Math.abs(n);
});

define(["min"], 1, Infinity, (c) => extreme(c, flatten(allArgs(c)), -1));
define(["max"], 1, Infinity, (c) => extreme(c, flatten(allArgs(c)), 1));
define(["sum"], 1, Infinity, (c) => sumOf(numbers(c, flatten(allArgs(c)))));
define(["avg", "average"], 1, Infinity, (c) => {
  const values = numbers(c, flatten(allArgs(c)));
  return values.length ? normalizeNumber(sumOf(values) / values.length) : null;
});
define(["count"], 1, Infinity, (c) => flatten(allArgs(c)).filter((v) => v !== null).length);

define(["sumof"], 2, 2, (c) => sumOf(numbers(c, perItem(c) ?? [])), 1);
define(
  ["avgof"],
  2,
  2,
  (c) => {
    const values = numbers(c, perItem(c) ?? []);
    return values.length ? normalizeNumber(sumOf(values) / values.length) : null;
  },
  1,
);
define(["minof"], 2, 2, (c) => extreme(c, perItem(c) ?? [], -1), 1);
define(["maxof"], 2, 2, (c) => extreme(c, perItem(c) ?? [], 1), 1);
define(
  ["countof"],
  2,
  2,
  (c) => {
    let n = 0;
    for (const v of perItem(c) ?? []) {
      if (v !== null && typeof v !== "boolean")
        fail(c, 1, `condition must be true or false but got ${typeName(v)}`);
      if (v === true) n++;
    }
    return n;
  },
  1,
);

define(["today"], 0, 0, (c) => formatIsoDate(c.now().getTime()));
define(["now"], 0, 0, (c) => formatIsoDateTime(c.now().getTime()));
define(["date"], 3, 3, (c) => {
  const y = int(c, 0);
  const m = int(c, 1);
  const d = int(c, 2);
  if (y === null || m === null || d === null) return null;
  const ms = utc(y, m - 1, d);
  const year = new Date(ms).getUTCFullYear();
  if (year < 1 || year > 9999) fail(c, 0, "year must be between 1 and 9999");
  return formatIsoDate(ms);
});
const datePart = (part: (d: Date) => number) => (c: Call) => {
  const d = date(c, 0);
  return d === null ? null : part(new Date(d.ms));
};
define(
  ["year"],
  1,
  1,
  datePart((d) => d.getUTCFullYear()),
);
define(
  ["month"],
  1,
  1,
  datePart((d) => d.getUTCMonth() + 1),
);
define(
  ["day"],
  1,
  1,
  datePart((d) => d.getUTCDate()),
);
define(
  ["hour"],
  1,
  1,
  datePart((d) => d.getUTCHours()),
);
define(
  ["minute"],
  1,
  1,
  datePart((d) => d.getUTCMinutes()),
);
define(
  ["weekday"],
  1,
  1,
  datePart((d) => d.getUTCDay() + 1),
);
define(["datediff"], 3, 3, (c) => {
  const unit = unitArg(c);
  const a = date(c, 1);
  const b = date(c, 2);
  if (unit === null || a === null || b === null) return null;
  return dateDiff(unit, a.ms, b.ms);
});
define(["dateadd"], 3, 3, (c) => {
  const unit = unitArg(c);
  const n = int(c, 1);
  const d = date(c, 2);
  if (unit === null || n === null || d === null) return null;
  const ms = dateAdd(unit, n, d.ms);
  const year = new Date(ms).getUTCFullYear();
  if (year < 1 || year > 9999) fail(c, 1, "result is outside years 1 to 9999");
  const timeUnit = unit === "hour" || unit === "minute" || unit === "second";
  return d.hasTime || timeUnit ? formatIsoDateTime(ms) : formatIsoDate(ms);
});

function formatArg(c: Call, value: Value, i: number): Value {
  const pattern = text(c, i);
  if (value === null || pattern === null) return null;
  if (typeof value === "object") fail(c, 0, `can't format ${typeName(value)}`);
  try {
    return formatValue(value, pattern);
  } catch (e) {
    if (e instanceof FormatError) return fail(c, 0, e.message);
    throw e;
  }
}
define(["format"], 2, 2, (c) => formatArg(c, c.arg(0), 1));
define(["text"], 1, 2, (c) => {
  const v = c.arg(0);
  if (c.count > 1) return formatArg(c, v, 1);
  if (v === null) return null;
  if (typeof v === "object") fail(c, 0, `can't convert ${typeName(v)} to text`);
  return toText(v);
});
define(["number"], 1, 1, (c) => {
  const v = c.arg(0);
  if (v === null || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const s = v.trim().replace(/,/g, "");
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s) ? Number(s) : null;
  }
  return fail(c, 0, `can't convert ${typeName(v)} to a number`);
});

export function lookupFunction(name: string): FnDef | undefined {
  return fns.get(name);
}

export function functionNames(): string[] {
  return [...fns.keys()].sort();
}

export function arityMessage(name: string, def: FnDef, count: number): string | null {
  if (count >= def.min && count <= def.max) return null;
  const range =
    def.min === def.max
      ? `${def.min}`
      : def.max === Infinity
        ? `at least ${def.min}`
        : `${def.min} to ${def.max}`;
  return `${name}() takes ${range} argument${range === "1" ? "" : "s"} but got ${count}`;
}
