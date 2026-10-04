import {
  type Aggregate,
  type BuilderCondition,
  type BuilderField,
  type BuilderGroup,
  type BuilderModel,
  type FilterValue,
  JOIN_KINDS,
  unaryOperator,
} from "./model";

export class BuilderError extends Error {}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Double-quotes an identifier, doubling embedded quotes. */
export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** SQL literal for a filter value. Strings are single-quoted with quotes doubled. */
export function quoteLiteral(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new BuilderError("Numbers in filters must be finite");
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function column(source: string, name: string, aliases: Set<string>) {
  if (!aliases.has(source)) throw new BuilderError(`Unknown source ${source}`);
  if (name === "*") return "*";
  return `${quoteIdent(source)}.${quoteIdent(name)}`;
}

function aggregate(kind: Aggregate | null | undefined, expr: string) {
  if (!kind) {
    if (expr === "*") throw new BuilderError("* is only allowed with Count");
    return expr;
  }
  if (expr === "*" && kind !== "count") throw new BuilderError("* is only allowed with Count");
  switch (kind) {
    case "countDistinct":
      return `count(DISTINCT ${expr})`;
    case "count":
    case "sum":
    case "avg":
    case "min":
    case "max":
      return `${kind}(${expr})`;
    default:
      throw new BuilderError(`Unknown aggregate ${String(kind)}`);
  }
}

/** Output column name for a field: its alias, or e.g. `sum_amount` for aggregates. */
export function fieldLabel(field: BuilderField): string {
  if (field.alias?.trim()) return field.alias.trim();
  if (!field.aggregate) return field.column;
  const suffix = field.column === "*" ? "" : `_${field.column}`;
  return `${field.aggregate === "countDistinct" ? "count_distinct" : field.aggregate}${suffix}`;
}

function operand(value: FilterValue | undefined): string {
  if (!value) throw new BuilderError("Filter needs a value");
  if (value.kind === "param") {
    if (!PARAM_NAME.test(value.name))
      throw new BuilderError(`Invalid parameter name ${JSON.stringify(value.name)}`);
    return `$${value.name}`;
  }
  return quoteLiteral(value.value);
}

function condition(c: BuilderCondition, aliases: Set<string>, allowAggregate: boolean): string {
  if (c.aggregate && !allowAggregate)
    throw new BuilderError(`Filter on ${c.column} uses an aggregate; move it to Having`);
  const expr = aggregate(c.aggregate, column(c.source, c.column, aliases));
  if (unaryOperator(c.operator)) return `${expr} IS ${c.operator === "isNull" ? "" : "NOT "}NULL`;
  const rhs = operand(c.value);
  switch (c.operator) {
    case "contains":
      return `contains(lower(CAST(${expr} AS VARCHAR)), lower(${rhs}))`;
    case "startsWith":
      return `starts_with(lower(CAST(${expr} AS VARCHAR)), lower(${rhs}))`;
    case "=":
    case "<>":
    case "<":
    case "<=":
    case ">":
    case ">=":
      return `${expr} ${c.operator} ${rhs}`;
    default:
      throw new BuilderError(`Unknown operator ${String(c.operator)}`);
  }
}

function group(g: BuilderGroup, aliases: Set<string>, allowAggregate: boolean): string {
  const parts = g.items
    .map((item) =>
      item.kind === "group"
        ? group(item, aliases, allowAggregate)
        : condition(item, aliases, allowAggregate),
    )
    .filter(Boolean);
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  const joiner = g.combinator === "or" ? " OR " : " AND ";
  return parts.map((p) => `(${p})`).join(joiner);
}

/**
 * Compiles a builder model to DuckDB SQL. Identifiers are double-quoted, literal
 * values single-quoted, and parameters emitted as `$name` placeholders that
 * queries.rs binds as typed values. Throws `BuilderError` for an inconsistent model.
 */
export function compileBuilder(model: BuilderModel): string {
  const [base, ...joined] = model.sources;
  if (!base) throw new BuilderError("Choose a source table");
  const aliases = new Set<string>();
  for (const s of model.sources) {
    if (!s.table || !s.alias) throw new BuilderError("Every source needs a table and an alias");
    if (aliases.has(s.alias)) throw new BuilderError(`Alias ${s.alias} is used twice`);
    aliases.add(s.alias);
  }
  const lines: string[] = [];
  const selected = model.fields.filter((f) => f.selected);
  const expr = (f: BuilderField) => aggregate(f.aggregate, column(f.source, f.column, aliases));
  lines.push(
    `SELECT ${
      selected.length
        ? selected.map((f) => `${expr(f)} AS ${quoteIdent(fieldLabel(f))}`).join(", ")
        : "*"
    }`,
  );
  lines.push(`FROM ${quoteIdent(base.table)} AS ${quoteIdent(base.alias)}`);
  const available = new Set([base.alias]);
  for (const source of joined) {
    const join = model.joins.find((j) => j.source === source.alias);
    if (!join) throw new BuilderError(`Choose how to join ${source.table}`);
    if (!join.conditions.length)
      throw new BuilderError(`Join to ${source.table} needs a condition`);
    const on = join.conditions.map((c) => {
      if (!available.has(c.leftSource))
        throw new BuilderError(`Join to ${source.table} refers to ${c.leftSource}`);
      if (!c.leftColumn || !c.rightColumn)
        throw new BuilderError(`Join to ${source.table} needs both columns`);
      return `${column(c.leftSource, c.leftColumn, aliases)} = ${column(source.alias, c.rightColumn, aliases)}`;
    });
    const kind = JOIN_KINDS.find((k) => k.id === join.kind)?.sql;
    if (!kind) throw new BuilderError(`Unknown join kind ${String(join.kind)}`);
    lines.push(
      `${kind} ${quoteIdent(source.table)} AS ${quoteIdent(source.alias)} ON ${on.join(" AND ")}`,
    );
    available.add(source.alias);
  }
  const where = group(model.filters, aliases, false);
  if (where) lines.push(`WHERE ${where}`);
  const aggregated = selected.some((f) => f.aggregate);
  const grouping = model.groupBy.map((g) => column(g.source, g.column, aliases));
  if (aggregated || grouping.length)
    for (const f of selected.filter((f) => !f.aggregate)) {
      const c = column(f.source, f.column, aliases);
      if (!grouping.includes(c)) grouping.push(c);
    }
  if (grouping.length) lines.push(`GROUP BY ${grouping.join(", ")}`);
  if (aggregated || grouping.length)
    for (const o of model.orderBy) {
      const field = model.fields.find((f) => f.id === o.fieldId);
      if (field && !field.aggregate && !grouping.includes(expr(field)))
        throw new BuilderError(`Sorting by ${field.column} needs it in Group by`);
    }
  const having = group(model.having, aliases, true);
  if (having) lines.push(`HAVING ${having}`);
  if (model.orderBy.length) {
    const order = model.orderBy.map((o) => {
      const field = model.fields.find((f) => f.id === o.fieldId);
      if (!field) throw new BuilderError("Sort refers to a removed field");
      return `${expr(field)} ${o.direction === "desc" ? "DESC" : "ASC"}`;
    });
    lines.push(`ORDER BY ${order.join(", ")}`);
  }
  if (model.limit != null) {
    if (!Number.isInteger(model.limit) || model.limit < 0)
      throw new BuilderError("Limit must be a whole number");
    lines.push(`LIMIT ${model.limit}`);
  }
  return lines.join("\n");
}

/** `compileBuilder` that returns the error message instead of throwing. */
export function tryCompile(model: BuilderModel): { sql: string; error: string } {
  try {
    return { sql: compileBuilder(model), error: "" };
  } catch (e) {
    return { sql: "", error: e instanceof Error ? e.message : String(e) };
  }
}
