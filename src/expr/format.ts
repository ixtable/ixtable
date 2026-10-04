import { normalizeNumber, parseIsoDate, roundTo, toText, type Value } from "./values";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export class FormatError extends Error {}

const NUMBER_CORE = /[#0][#0,]*(?:\.[#0]*)?|\.[#0]+/;

function stripLiteral(text: string): string {
  return text.replace(/\\(.)/g, "$1").replace(/["']/g, "");
}

export function formatNumber(n: number, pattern: string): string {
  const match = NUMBER_CORE.exec(pattern);
  if (!match) throw new FormatError(`'${pattern}' is not a number format`);
  const prefix = stripLiteral(pattern.slice(0, match.index));
  const suffix = stripLiteral(pattern.slice(match.index + match[0].length));
  const [intPattern, fracPattern = ""] = match[0].split(".");
  let value = n;
  if (prefix.includes("%") || suffix.includes("%")) value = normalizeNumber(value * 100);
  const minInt = (intPattern.match(/0/g) ?? []).length;
  const minFrac = (fracPattern.match(/0/g) ?? []).length;
  const maxFrac = fracPattern.length;
  const rounded = roundTo(value, maxFrac);
  const negative = rounded < 0;
  let [intDigits, fracDigits = ""] = Math.abs(rounded).toFixed(maxFrac).split(".");
  while (fracDigits.length > minFrac && fracDigits.endsWith("0")) {
    fracDigits = fracDigits.slice(0, -1);
  }
  if (minInt === 0 && intDigits === "0") intDigits = "";
  intDigits = intDigits.padStart(minInt, "0");
  if (intPattern.includes(",")) intDigits = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = fracDigits ? `${intDigits}.${fracDigits}` : intDigits || "0";
  return `${negative ? "-" : ""}${prefix}${body}${suffix}`;
}

const DATE_TOKEN = /yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|tt|'[^']*'|"[^"]*"/g;

export function formatDate(iso: string, pattern: string): string {
  const parsed = parseIsoDate(iso);
  if (!parsed) throw new FormatError(`'${iso}' is not a date`);
  const d = new Date(parsed.ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  const hours = d.getUTCHours();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return pattern.replace(DATE_TOKEN, (token) => {
    switch (token) {
      case "yyyy":
        return String(year).padStart(4, "0");
      case "yy":
        return pad(year % 100);
      case "MMMM":
        return MONTHS[month];
      case "MMM":
        return MONTHS[month].slice(0, 3);
      case "MM":
        return pad(month + 1);
      case "M":
        return String(month + 1);
      case "dddd":
        return DAYS[d.getUTCDay()];
      case "ddd":
        return DAYS[d.getUTCDay()].slice(0, 3);
      case "dd":
        return pad(day);
      case "d":
        return String(day);
      case "HH":
        return pad(hours);
      case "H":
        return String(hours);
      case "hh":
        return pad(hour12);
      case "h":
        return String(hour12);
      case "mm":
        return pad(d.getUTCMinutes());
      case "m":
        return String(d.getUTCMinutes());
      case "ss":
        return pad(d.getUTCSeconds());
      case "s":
        return String(d.getUTCSeconds());
      case "tt":
        return hours < 12 ? "AM" : "PM";
      default:
        return token.slice(1, -1);
    }
  });
}

/**
 * Formats a value for display. Numbers use number patterns (`#,##0.00`,
 * `0%`, `$#,##0.00`); date text uses date patterns (`yyyy-MM-dd`,
 * `MMM d, yyyy`). Without a pattern the value is converted to plain text.
 * Null formats as an empty string.
 */
export function formatValue(value: unknown, pattern?: string | null): string {
  const v = value instanceof Date ? value.toISOString().slice(0, 19) : (value as Value);
  if (v === null || v === undefined) return "";
  if (!pattern) return toText(v);
  if (typeof v === "number") return formatNumber(v, pattern);
  if (typeof v === "string" && parseIsoDate(v)) return formatDate(v, pattern);
  throw new FormatError(`Can't apply format '${pattern}' to ${JSON.stringify(v)}`);
}
