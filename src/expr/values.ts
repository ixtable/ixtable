export type Value = number | string | boolean | null | Value[] | { [key: string]: unknown };

const SIGNIFICANT_DIGITS = 15;

/**
 * Rounds a computed number to 15 significant digits so that binary floating
 * point noise never shows up in results (0.1 + 0.2 is 0.3, 1.1 * 3 is 3.3).
 * 15 digits is the most a double can round-trip exactly.
 */
export function normalizeNumber(n: number): number {
  if (!Number.isFinite(n)) return n;
  if (n === 0) return 0;
  return Number(n.toPrecision(SIGNIFICANT_DIGITS));
}

/** Rounds half away from zero to `digits` decimal places, without float drift. */
export function roundTo(n: number, digits: number): number {
  const scale = 10 ** digits;
  const scaled = normalizeNumber(n * scale);
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return normalizeNumber(rounded / scale);
}

export function typeName(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "list";
  if (typeof v === "string") return "text";
  if (typeof v === "object") return "record";
  return typeof v;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Converts a value read from the caller's scope into an expression value. */
export function fromHost(v: unknown): Value {
  if (v === undefined || v === null) return null;
  switch (typeof v) {
    case "number":
      return Number.isNaN(v) ? null : v;
    case "string":
    case "boolean":
      return v;
    case "bigint":
      return Number(v);
    case "object":
      if (v instanceof Date)
        return Number.isNaN(v.getTime()) ? null : formatIsoDateTime(v.getTime());
      return v as Value;
    default:
      return null;
  }
}

export interface ParsedDate {
  ms: number;
  hasTime: boolean;
  iso: string;
}

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Parses `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS]` (optionally with `Z` or an
 * offset, which is converted to UTC). Returns null when the text is not a
 * real calendar date.
 */
export function parseIsoDate(text: string): ParsedDate | null {
  const m = ISO_DATE.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = h ? Number(h) : 0;
  const minute = mi ? Number(mi) : 0;
  const second = s ? Number(s) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  let ms = utc(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) return null;
  if (zone && zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
  }
  const hasTime = h !== undefined;
  return { ms, hasTime, iso: hasTime ? formatIsoDateTime(ms) : formatIsoDate(ms) };
}

export function utc(y: number, m: number, d: number, h = 0, mi = 0, s = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m, d);
  date.setUTCHours(h, mi, s, 0);
  return date.getTime();
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function formatIsoDate(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatIsoDateTime(ms: number): string {
  const d = new Date(ms);
  return `${formatIsoDate(ms)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Orders two non-null values. Returns undefined when they are different kinds
 * and cannot be ordered. Text that is a date in both operands compares as a
 * date, so `2026-01-31` equals `2026-01-31T00:00:00`.
 */
export function compareValues(a: Value, b: Value): number | undefined {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return 0;
    const da = parseIsoDate(a);
    const db = da && parseIsoDate(b);
    if (da && db) return da.ms === db.ms ? 0 : da.ms < db.ms ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return undefined;
}

export function toText(v: Value): string {
  if (v === null) return "";
  if (typeof v === "number") return String(normalizeNumber(v));
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
