import { newId } from "../../lib/utils";

/** Visual query builder model, stored as JSON in `SavedQuery.builder` (PRD §12). */
export type Aggregate = "count" | "sum" | "avg" | "min" | "max" | "countDistinct";
export const AGGREGATES: ReadonlyArray<{ id: Aggregate; label: string }> = [
  { id: "count", label: "Count" },
  { id: "countDistinct", label: "Count distinct" },
  { id: "sum", label: "Sum" },
  { id: "avg", label: "Average" },
  { id: "min", label: "Min" },
  { id: "max", label: "Max" },
];

export interface BuilderSource {
  id: string;
  table: string;
  // SQL alias; unique within the model. The first source is the FROM table.
  alias: string;
}

export interface JoinCondition {
  // Alias of a source listed before the joined one.
  leftSource: string;
  leftColumn: string;
  // Column of the joined source.
  rightColumn: string;
}

export interface BuilderJoin {
  id: string;
  kind: "inner" | "left";
  // Alias of the joined source.
  source: string;
  conditions: JoinCondition[];
}

export interface BuilderField {
  id: string;
  source: string;
  // Column name, or `*` (only with `count`).
  column: string;
  alias?: string;
  aggregate?: Aggregate | null;
  selected: boolean;
}

export type FilterOperator =
  | "="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "contains"
  | "startsWith"
  | "isNull"
  | "isNotNull";
export const FILTER_OPERATORS: ReadonlyArray<{ id: FilterOperator; label: string }> = [
  { id: "=", label: "equals" },
  { id: "<>", label: "does not equal" },
  { id: "<", label: "less than" },
  { id: "<=", label: "at most" },
  { id: ">", label: "greater than" },
  { id: ">=", label: "at least" },
  { id: "contains", label: "contains" },
  { id: "startsWith", label: "starts with" },
  { id: "isNull", label: "is empty" },
  { id: "isNotNull", label: "is not empty" },
];
export const unaryOperator = (op: FilterOperator) => op === "isNull" || op === "isNotNull";

export type FilterValue =
  | { kind: "value"; value: string | number | boolean | null }
  | { kind: "param"; name: string };

export interface BuilderCondition {
  id: string;
  kind: "condition";
  source: string;
  column: string;
  // Only in `having`: compare an aggregate of the column.
  aggregate?: Aggregate | null;
  operator: FilterOperator;
  value?: FilterValue;
}

export interface BuilderGroup {
  id: string;
  kind: "group";
  combinator: "and" | "or";
  items: Array<BuilderCondition | BuilderGroup>;
}

export interface BuilderSort {
  id: string;
  fieldId: string;
  direction: "asc" | "desc";
}

export interface BuilderModel {
  version: 1;
  sources: BuilderSource[];
  joins: BuilderJoin[];
  fields: BuilderField[];
  filters: BuilderGroup;
  // Explicit grouping. Non-aggregated selected fields are grouped automatically when any field aggregates.
  groupBy: Array<{ source: string; column: string }>;
  having: BuilderGroup;
  orderBy: BuilderSort[];
  limit?: number | null;
}

export const emptyGroup = (): BuilderGroup => ({
  id: newId(),
  kind: "group",
  combinator: "and",
  items: [],
});

export const emptyModel = (): BuilderModel => ({
  version: 1,
  sources: [],
  joins: [],
  fields: [],
  filters: emptyGroup(),
  groupBy: [],
  having: emptyGroup(),
  orderBy: [],
  limit: null,
});

/** Fills missing collections so older or hand-edited models load. */
export function normalizeModel(raw: unknown): BuilderModel {
  const m = (raw && typeof raw === "object" ? raw : {}) as Partial<BuilderModel>;
  const group = (g: BuilderGroup | undefined) => (g && Array.isArray(g.items) ? g : emptyGroup());
  return {
    version: 1,
    sources: Array.isArray(m.sources) ? m.sources : [],
    joins: Array.isArray(m.joins) ? m.joins : [],
    fields: Array.isArray(m.fields) ? m.fields : [],
    filters: group(m.filters),
    groupBy: Array.isArray(m.groupBy) ? m.groupBy : [],
    having: group(m.having),
    orderBy: Array.isArray(m.orderBy) ? m.orderBy : [],
    limit: m.limit ?? null,
  };
}

/** True when the model holds nothing worth confirming before it is discarded. */
export const isEmptyModel = (m: BuilderModel) => m.sources.length === 0;

/** A short alias for a table that is not yet used in the model (`orders` → `o`, `o2`). */
export function aliasFor(table: string, used: string[]): string {
  const base = (table.match(/[A-Za-z]/)?.[0] ?? "t").toLowerCase();
  if (!used.includes(base)) return base;
  let n = 2;
  while (used.includes(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** Every condition in a group tree, depth first. */
export function conditionsOf(group: BuilderGroup): BuilderCondition[] {
  return group.items.flatMap((item) => (item.kind === "group" ? conditionsOf(item) : [item]));
}

/** Parameter names referenced by filters and having conditions. */
export function builderParameterNames(model: BuilderModel): string[] {
  const names = [...conditionsOf(model.filters), ...conditionsOf(model.having)].flatMap((c) =>
    c.value?.kind === "param" && c.value.name ? [c.value.name] : [],
  );
  return [...new Set(names)];
}

/** Display name of a field: `alias.column`, or Row count for `count(*)`. */
export const fieldName = (f: BuilderField) =>
  f.column === "*" ? "Row count" : `${f.source}.${f.column}`;
