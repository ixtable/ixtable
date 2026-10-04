import { tryCompile } from "./builder/compile";
import { normalizeModel } from "./builder/model";
import type { SavedQuery } from "./types";

/**
 * `$name` placeholders in SQL, in first-use order, skipping strings, quoted
 * identifiers, comments, and dollar-quoted strings. Mirrors `rewrite_placeholders`
 * in queries.rs (which is authoritative); used for live parameter hints.
 */
export function placeholderNames(sql: string): string[] {
  const names: string[] = [];
  let i = 0;
  const ident = /[A-Za-z0-9_]/;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "$") {
      let j = i + 1;
      while (j < sql.length && ident.test(sql[j])) j++;
      const word = sql.slice(i + 1, j);
      if (sql[j] === "$") {
        const tag = sql.slice(i, j + 1);
        const end = sql.indexOf(tag, j + 1);
        i = end < 0 ? sql.length : end + tag.length;
      } else {
        if (/^[A-Za-z_]/.test(word) && !names.includes(word)) names.push(word);
        i = Math.max(j, i + 1);
      }
    } else i++;
  }
  return names;
}

/** The SQL a query runs: compiled from the builder model when it has one. */
export function effectiveSql(query: SavedQuery): { sql: string; error: string } {
  if (!query.builder) return { sql: query.sql, error: "" };
  return tryCompile(normalizeModel(query.builder));
}

/** Form values → run params; blank values are omitted so defaults apply. */
export const runParams = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
