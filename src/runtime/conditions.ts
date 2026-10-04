/**
 * Expression-driven row filters and conditional styles (PRD §17.1). Evaluated here in
 * TypeScript with `src/expr`; Rust only stores the expressions.
 */
import { evaluateBoolean, parse } from "../expr";

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
/** Rows scanned before a filtered page may stop and report its total as a lower bound. */
export const SCAN_BUDGET = 5000;
/** Hard stop, so a filter that matches almost nothing cannot scan a huge table forever. */
export const SCAN_LIMIT = 50_000;

export type Scan<T> = { matches: T[]; exhausted: boolean };

/**
 * Reads a source in chunks and keeps the items that pass `keep`. It scans at least
 * `minScan` rows (or the whole source), then continues until at least `need` matches are
 * found, never past `SCAN_LIMIT` rows. When `exhausted` is false, `matches.length` is
 * only a lower bound on the total.
 */
export async function scanFiltered<T>(
  fetch: (offset: number, limit: number) => Promise<T[]>,
  keep: (item: T) => boolean,
  need: number,
  { minScan = SCAN_BUDGET, chunk = SCAN_CHUNK }: { minScan?: number; chunk?: number } = {},
): Promise<Scan<T>> {
  const matches: T[] = [];
  let scanned = 0;
  for (;;) {
    const items = await fetch(scanned, chunk);
    scanned += items.length;
    for (const item of items) if (keep(item)) matches.push(item);
    if (items.length < chunk) return { matches, exhausted: true };
    const enough = scanned >= minScan && matches.length >= need;
    if (enough || scanned >= SCAN_LIMIT) return { matches, exhausted: false };
  }
}

/** Pager text for a page of a (possibly filtered) list. */
export function pageLabel(offset: number, shown: number, total: number, exact: boolean): string {
  if (!total) return exact ? "0 records" : "No matching records in the rows scanned";
  const range = `${offset + 1}–${offset + shown}`;
  return exact ? `${range} of ${total}` : `${range} of at least ${total}`;
}
