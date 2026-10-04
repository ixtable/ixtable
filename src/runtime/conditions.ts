/**
 * Expression-driven row filters and conditional styles (PRD §17.1). Evaluated here in
 * TypeScript with `src/expr`; Rust only stores the expressions.
 */
import { evaluateBoolean, parse, referencedNames } from "../expr";

/** Named tones; each maps to a `tone-<name>` CSS class, never to raw CSS (PRD §6.3). */
export type Tone = "positive" | "negative" | "warning" | "muted" | "emphasis";
export const TONES: Tone[] = ["positive", "negative", "warning", "muted", "emphasis"];

/** One conditional style rule. The first rule whose `when` is true wins. */
export type ConditionalStyle = {
  id: string;
  when: string;
  tone: Tone;
  // Dashboard tables: the column this rule styles. Unset on form controls.
  column?: string | null;
};

const present = (src?: string | null): src is string => !!src && src.trim() !== "";

/** True when the condition holds; blank, invalid, or failing expressions give false. */
function holds(src: string, scope: Record<string, unknown>): boolean {
  try {
    return evaluateBoolean(src, scope);
  } catch {
    return false;
  }
}

/** Tone of the first matching rule (optionally only rules for `column`), else null. */
export function toneFor(
  rules: ConditionalStyle[] | null | undefined,
  scope: Record<string, unknown>,
  column?: string,
): Tone | null {
  for (const rule of rules ?? []) {
    if (column !== undefined && rule.column !== column) continue;
    if (present(rule.when) && TONES.includes(rule.tone) && holds(rule.when, scope))
      return rule.tone;
  }
  return null;
}

/** CSS class for a tone ("" when none). */
export const toneClass = (tone: Tone | null) => (tone ? `tone tone-${tone}` : "");

/** Names a row filter may use: the row as `record`, plus `parent`, `form`, `app`, `params`. */
export function filterNames(columns?: string[]): string[] {
  const record = columns?.length ? columns.map((c) => `record.${c}`) : ["record"];
  return [...record, "parent", "form", "app", "params"];
}

/**
 * The part of `scope` a row filter reads: every name it references except the row itself
 * (`record`), copied into a pruned scope. Two scopes with equal inputs give equal JSON, so
 * callers key reloads on it and edits to unreferenced fields do not reload. A filter that
 * does not parse gives an empty scope (the load then reports the syntax error).
 */
export function filterInputs(
  src: string | null | undefined,
  scope: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  if (!present(src)) return picked;
  let names: string[];
  try {
    names = referencedNames(src);
  } catch {
    return picked;
  }
  // Shorter paths first: once `parent` is copied whole, `parent.x` adds nothing.
  const sorted = names.sort((a, b) => a.split(".").length - b.split(".").length);
  const taken: string[] = [];
  for (const name of sorted) {
    if (name === "record" || name.startsWith("record.")) continue;
    if (taken.some((t) => name.startsWith(`${t}.`))) continue;
    taken.push(name);
    const path = name.split(".");
    let source: unknown = scope;
    let target = picked;
    for (const [i, key] of path.entries()) {
      source = (source as Record<string, unknown>)[key];
      const nested = source !== null && typeof source === "object" && !Array.isArray(source);
      // A missing or scalar value is copied as is; reading past it fails the same way.
      if (i === path.length - 1 || !nested) {
        target[key] = source;
        break;
      }
      target[key] ??= {};
      target = target[key] as Record<string, unknown>;
    }
  }
  return picked;
}

/** Stable key of `filterInputs` ("" without a filter): reload a filtered list when it changes. */
export function filterInputsKey(
  src: string | null | undefined,
  scope: Record<string, unknown>,
): string {
  return present(src) ? JSON.stringify([src, filterInputs(src, scope)]) : "";
}

export type RowPredicate = (record: Record<string, unknown>) => boolean;

/**
 * Compiles a filter expression into a row predicate, or null when the filter is blank.
 * A syntax error throws so the caller can show it; a row whose evaluation fails is
 * excluded (null and errors count as false, as in every other condition).
 */
export function rowFilter(
  src: string | null | undefined,
  scope: Record<string, unknown>,
): RowPredicate | null {
  if (!present(src)) return null;
  const ast = parse(src);
  return (record) => {
    try {
      return evaluateBoolean(ast, { ...scope, record });
    } catch {
      return false;
    }
  };
}

/** Rows read per chunk while scanning for filtered matches (read_table_page allows 1000). */
export const SCAN_CHUNK = 500;
/** Hard stop, so a filter that matches almost nothing cannot scan a huge table forever. */
export const SCAN_LIMIT = 50_000;

export type Scan<T> = { matches: T[]; exhausted: boolean };

/**
 * Reads a source in chunks and keeps the items that pass `keep`, until at least `need`
 * matches are found, the source ends (`exhausted`), or `SCAN_LIMIT` rows were read.
 */
export async function scanFiltered<T>(
  fetch: (offset: number, limit: number) => Promise<T[]>,
  keep: (item: T) => boolean,
  need: number,
  chunk = SCAN_CHUNK,
): Promise<Scan<T>> {
  const matches: T[] = [];
  let scanned = 0;
  for (;;) {
    const items = await fetch(scanned, chunk);
    scanned += items.length;
    for (const item of items) if (keep(item)) matches.push(item);
    if (items.length < chunk) return { matches, exhausted: true };
    if (matches.length >= need || scanned >= SCAN_LIMIT) return { matches, exhausted: false };
  }
}

export type ScanResult<T> = { matches: T[]; truncated: boolean };

/**
 * Scans a whole source (up to `SCAN_LIMIT` rows) and keeps every match, so a list can page
 * through the matches without rescanning. `truncated` means rows past the limit were not read.
 */
export async function pagedScan<T>(
  fetch: (offset: number, limit: number) => Promise<T[]>,
  keep: (item: T) => boolean,
): Promise<ScanResult<T>> {
  const scan = await scanFiltered(fetch, keep, Number.POSITIVE_INFINITY);
  return { matches: scan.matches, truncated: !scan.exhausted };
}

/** Shown above a filtered list whose scan stopped at `SCAN_LIMIT`. */
export const TRUNCATED_NOTICE = `Filter applied to the first ${SCAN_LIMIT.toLocaleString("en-US")} rows; some matches may be missing.`;

/** Pager text for a page of a list. */
export function pageLabel(offset: number, shown: number, total: number): string {
  if (!total) return "0 records";
  return `${offset + 1}–${offset + shown} of ${total}`;
}
