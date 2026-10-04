import type { TableSchema } from "../lib/types";

/** A relationship drawn on the canvas: `child.column` references `parent.column`. */
export interface DrawnRelationship {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
}

export interface RelationshipEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  label?: string;
}

export const handleId = (index: number, direction: "source" | "target") => `c${index}-${direction}`;
const columnIndex = (handle: string | null | undefined) =>
  Number(handle?.match(/^c(\d+)-/)?.[1] ?? -1);

/** True when `columns` contain a primary key, unique constraint, unique index, or unique column. */
export function isUniqueKey(schema: TableSchema, columns: string[]): boolean {
  const primary =
    schema.primaryKey ?? schema.columns.filter((c) => c.primaryKeyPosition).map((c) => c.name);
  const keys = [
    primary,
    ...(schema.uniques ?? []).map((u) => u.columns),
    ...(schema.indexes ?? []).filter((i) => i.unique).map((i) => i.columns),
    ...schema.columns.filter((c) => c.unique).map((c) => [c.name]),
  ];
  return keys.some((key) => key.length > 0 && key.every((c) => columns.includes(c)));
}

/**
 * Diagram edges: one per column pair of each foreign key, so composite keys anchor on every
 * column. The first pair carries the label: `1 — 1` when the referencing columns are unique,
 * else `1 — ∞`, followed by the column list for composite keys.
 */
export function relationshipEdges(schemas: TableSchema[]): RelationshipEdge[] {
  return schemas.flatMap((schema) =>
    schema.foreignKeys.flatMap((key) => {
      const target = schemas.find((s) => s.name === key.targetTable);
      const cardinality = isUniqueKey(schema, key.fromColumns) ? "1 — 1" : "1 — ∞";
      const composite = key.fromColumns.length > 1 ? ` (${key.fromColumns.join(", ")})` : "";
      return key.fromColumns.map((from, i) => ({
        id: `${schema.name}-${key.id}-${i}`,
        source: key.targetTable,
        sourceHandle: handleId(
          Math.max(0, target?.columns.findIndex((c) => c.name === key.targetColumns[i]) ?? 0),
          "source",
        ),
        target: schema.name,
        targetHandle: handleId(
          Math.max(
            0,
            schema.columns.findIndex((c) => c.name === from),
          ),
          "target",
        ),
        ...(i === 0 ? { label: `${cardinality}${composite}` } : {}),
      }));
    }),
  );
}

/** The relationship a canvas connection proposes, from a parent's right handle to a child's left one. */
export function drawnFrom(
  connection: {
    source: string | null;
    target: string | null;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
  schemas: TableSchema[],
): DrawnRelationship | null {
  const parent = schemas.find((s) => s.name === connection.source);
  const child = schemas.find((s) => s.name === connection.target);
  const parentColumn = parent?.columns[columnIndex(connection.sourceHandle)]?.name;
  const childColumn = child?.columns[columnIndex(connection.targetHandle)]?.name;
  return parent && child && parentColumn && childColumn
    ? { childTable: child.name, childColumn, parentTable: parent.name, parentColumn }
    : null;
}
