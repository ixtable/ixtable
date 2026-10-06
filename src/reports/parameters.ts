import type { QueryParameter, SavedQuery } from "../query/types";
import { bandEntries } from "./model";
import type { Report } from "./types";

/**
 * Parameters a report needs: those its dataset query declares, then those of
 * its tables' queries (first declaration wins), with the report's own
 * defaults ahead of the query defaults.
 */
export function reportParameters(report: Report, queries: SavedQuery[]): QueryParameter[] {
  const ids = [
    report.datasetQueryId,
    ...bandEntries(report).flatMap((entry) =>
      entry.band.components.flatMap((c) => (c.kind === "table" && c.queryId ? [c.queryId] : [])),
    ),
  ];
  const seen = new Map<string, QueryParameter>();
  for (const id of ids) {
    const query = queries.find((q) => q.id === id);
    for (const p of query?.parameters ?? [])
      if (!seen.has(p.name))
        seen.set(p.name, {
          ...p,
          defaultValue: report.params?.[p.name] ?? p.defaultValue,
        });
  }
  return [...seen.values()];
}

export const inputType = (type: string) =>
  type === "integer" || type === "number"
    ? "number"
    : type === "date"
      ? "date"
      : type === "timestamp"
        ? "datetime-local"
        : "text";

export const display = (value: unknown) =>
  value === null || value === undefined || typeof value === "boolean" ? "" : String(value);

/** Typed value of one prompt field, or an error message. */
export function parseParameter(
  p: QueryParameter,
  raw: string | boolean,
): { value: unknown } | { error: string } {
  if (typeof raw === "boolean") return { value: raw };
  const text = raw.trim();
  if (!text) return p.required ? { error: `Enter a value for ${p.name}.` } : { value: null };
  if (p.logicalType === "integer" || p.logicalType === "number") {
    const n = Number(text);
    if (!Number.isFinite(n) || (p.logicalType === "integer" && !Number.isInteger(n)))
      return {
        error: `${p.name} must be ${p.logicalType === "integer" ? "a whole" : "a"} number.`,
      };
    return { value: n };
  }
  return { value: text };
}
