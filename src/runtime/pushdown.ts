/**
 * Row filter pushdown: the parts of a form's row filter that DuckDB can apply as table
 * page filters (`Filter[]`), so a filtered list over a large table reads only matching
 * rows instead of scanning them in TypeScript. The expression is still only evaluated
 * here: every value a pushed filter compares with is computed by `src/expr`, and Rust
 * receives plain column filters. Anything whose SQL result could differ from the
 * expression's result stays in the residual expression, evaluated per row as before.
 */
import type { Ast } from "../expr";
import { evalNode, makeEnv } from "../expr/evaluate";
import { parseIsoDate, type Value } from "../expr/values";
import type { DataValue, DbColumn, Filter, FilterOperator } from "../lib/types";
import { logicalOf, parseLogical } from "../schema/logical";

/** `filters` run in DuckDB; `rest` (null when nothing is left) runs per row in TypeScript. */
export type Pushdown = { filters: Filter[]; rest: Ast | null };

const COMPARISON: Record<string, FilterOperator> = {
  "=": "eq",
  "!=": "ne",
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
};
const FLIPPED: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

/** Top-level `and` operands: a row passes the filter exactly when each one is true. */
function conjuncts(node: Ast): Ast[] {
  return node.type === "binary" && node.op === "and"
    ? [...conjuncts(node.left), ...conjuncts(node.right)]
    : [node];
}

function readsRecord(node: Ast): boolean {
  switch (node.type) {
    case "name":
      return node.path[0] === "record";
    case "unary":
      return readsRecord(node.operand);
    case "binary":
      return readsRecord(node.left) || readsRecord(node.right);
    case "in":
      return readsRecord(node.operand) || node.list.some(readsRecord);
    case "between":
      return [node.operand, node.low, node.high].some(readsRecord);
    case "isnull":
      return readsRecord(node.operand);
    case "call":
      return node.args.some(readsRecord);
    default:
      return false;
  }
}

/** `record.<column>` of a known column, or null. */
function columnOf(node: Ast, columns: Map<string, DbColumn>): DbColumn | null {
  return node.type === "name" && node.path.length === 2 && node.path[0] === "record"
    ? (columns.get(node.path[1]) ?? null)
    : null;
}

/** The value of a subexpression that does not read the row; undefined when it fails. */
function constant(node: Ast, scope: Record<string, unknown>): Value | undefined {
  if (readsRecord(node)) return undefined;
  try {
    return evalNode(node, makeEnv(scope));
  } catch {
    return undefined;
  }
}

/**
 * The bound value for comparing `column` with `value` in SQL, or null when SQL and the
 * expression could disagree: numbers only against integer and real columns (decimal
 * values are text in TypeScript), text only against text columns, and only for equality
 * and never with text that reads as a date (the expression compares dates by instant).
 */
function bindable(column: DbColumn, value: Value, equality: boolean): DataValue | null {
  const base = parseLogical(logicalOf(column)).base;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (base === "integer" || base === "real")
  )
    return Number.isInteger(value) ? { type: "integer", value } : { type: "real", value };
  if (typeof value === "string" && base === "text" && equality && parseIsoDate(value) === null)
    return { type: "text", value };
  return null;
}

function translate(
  node: Ast,
  scope: Record<string, unknown>,
  columns: Map<string, DbColumn>,
): Filter[] | null {
  if (node.type === "isnull") {
    const column = columnOf(node.operand, columns);
    if (!column) return null;
    return [{ column: column.name, operator: node.negated ? "is_not_null" : "is_null" }];
  }
  if (node.type === "binary" && node.op in COMPARISON) {
    let [field, other, op] = [node.left, node.right, node.op as string];
    if (!columnOf(field, columns)) [field, other, op] = [other, field, FLIPPED[op] ?? op];
    const column = columnOf(field, columns);
    const value = column && constant(other, scope);
    if (!column || value === undefined || value === null) return null;
    const bound = bindable(column, value, op === "=" || op === "!=");
    return bound && [{ column: column.name, operator: COMPARISON[op], value: bound }];
  }
  if (node.type === "between" && !node.negated) {
    const column = columnOf(node.operand, columns);
    if (!column) return null;
    const [low, high] = [constant(node.low, scope), constant(node.high, scope)];
    if (low == null || high == null) return null;
    const bounds = [bindable(column, low, false), bindable(column, high, false)];
    if (!bounds[0] || !bounds[1]) return null;
    return [
      { column: column.name, operator: "gte", value: bounds[0] },
      { column: column.name, operator: "lte", value: bounds[1] },
    ];
  }
  if (node.type === "in" && !node.negated) {
    const column = columnOf(node.operand, columns);
    if (!column) return null;
    const values: DataValue[] = [];
    for (const item of node.list) {
      const raw = constant(item, scope);
      if (raw === undefined) return null;
      for (const v of Array.isArray(raw) ? raw : [raw]) {
        const bound = v === null ? null : bindable(column, v as Value, true);
        if (!bound) return null;
        values.push(bound);
      }
    }
    return [{ column: column.name, operator: "in", values }];
  }
  return null;
}

/** Splits a parsed row filter into DuckDB filters over `columns` and a residual expression. */
export function pushdown(ast: Ast, scope: Record<string, unknown>, columns: DbColumn[]): Pushdown {
  const byName = new Map(columns.map((column) => [column.name, column]));
  const filters: Filter[] = [];
  const rest: Ast[] = [];
  for (const part of conjuncts(ast)) {
    const pushed = translate(part, scope, byName);
    if (pushed) filters.push(...pushed);
    else rest.push(part);
  }
  const residual = rest.reduce<Ast | null>(
    (left, right) =>
      left ? { type: "binary", op: "and", left, right, start: left.start, end: right.end } : right,
    null,
  );
  return { filters, rest: residual };
}
