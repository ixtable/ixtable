import type { TableSchema } from "../lib/types";

const LAYOUT_COLUMNS = 3;
const COLUMN_WIDTH = 300;
const NODE_HEADER = 40;
const FIELD_HEIGHT = 24;
const ROW_GAP = 50;
const MIN_ROW_HEIGHT = 140;
const LEFT = 30;
const TOP = 25;

type LayoutSchema = Pick<TableSchema, "columns"> &
  Partial<Pick<TableSchema, "name" | "foreignKeys">>;
type Position = { x: number; y: number };

const nodeHeight = (schema: LayoutSchema) =>
  Math.max(MIN_ROW_HEIGHT, NODE_HEADER + schema.columns.length * FIELD_HEIGHT);

/**
 * Default node positions. Related tables are laid out by foreign-key dependency: referenced
 * tables in the left column and each referencing table one column right of its deepest
 * parent, so every edge runs left to right between neighbouring columns instead of behind
 * other nodes. Within a column, tables sit next to their parents (barycenter order).
 * Tables without relationships follow in rows of three below the related ones.
 */
export function defaultLayout(schemas: LayoutSchema[]): Position[] {
  const names = new Map(schemas.map((schema, index) => [schema.name ?? `#${index}`, index]));
  // Parent indexes of each table (self-references and unknown targets ignored).
  const parents = schemas.map((schema, index) => [
    ...new Set(
      (schema.foreignKeys ?? [])
        .map((key) => names.get(key.targetTable))
        .filter((parent): parent is number => parent !== undefined && parent !== index),
    ),
  ]);
  const related = new Set<number>();
  parents.forEach((list, index) => {
    if (list.length) related.add(index);
    for (const parent of list) related.add(parent);
  });

  const level = levels(parents, related);
  const columns: number[][] = [];
  for (const index of [...related].sort((a, b) => a - b))
    (columns[level[index]] ??= []).push(index);
  const positions: Position[] = [];
  let bottom = TOP;
  columns.forEach((column, depth) => {
    // Order by the average row of the parents already placed (stable for ties).
    const rank = (index: number) => {
      const placed = parents[index].filter((parent) => positions[parent]);
      return placed.length
        ? placed.reduce((sum, parent) => sum + positions[parent].y, 0) / placed.length
        : Number.POSITIVE_INFINITY;
    };
    const ordered = depth === 0 ? column : [...column].sort((a, b) => rank(a) - rank(b) || a - b);
    let top = TOP;
    for (const index of ordered) {
      positions[index] = { x: LEFT + depth * COLUMN_WIDTH, y: top };
      top += nodeHeight(schemas[index]) + ROW_GAP;
    }
    bottom = Math.max(bottom, top);
  });

  const isolated = schemas.map((_, index) => index).filter((index) => !related.has(index));
  let top = related.size ? bottom : TOP;
  for (let start = 0; start < isolated.length; start += LAYOUT_COLUMNS) {
    const row = isolated.slice(start, start + LAYOUT_COLUMNS);
    row.forEach((index, column) => {
      positions[index] = { x: LEFT + column * COLUMN_WIDTH, y: top };
    });
    top += Math.max(...row.map((index) => nodeHeight(schemas[index]))) + ROW_GAP;
  }
  return positions;
}

/** Column of each related table: 0 for tables with no parents, else one past the deepest parent. */
function levels(parents: number[][], related: Set<number>): number[] {
  const level: number[] = [];
  const visiting = new Set<number>();
  const visit = (index: number): number => {
    if (level[index] !== undefined) return level[index];
    // A cycle (A → B → A) is cut where it is found.
    if (visiting.has(index)) return -1;
    visiting.add(index);
    const deepest = Math.max(-1, ...parents[index].map(visit));
    visiting.delete(index);
    level[index] = deepest + 1;
    return level[index];
  };
  for (const index of related) visit(index);
  return level;
}
