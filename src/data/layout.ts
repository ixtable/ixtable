import type { TableSchema } from "../lib/types";

const LAYOUT_COLUMNS = 3;
const NODE_HEADER = 40;
const FIELD_HEIGHT = 24;
const ROW_GAP = 50;
const MIN_ROW_HEIGHT = 140;

/**
 * Default node positions: three columns, each row starting below the tallest table of the
 * row above so tables with many fields never overlap the next row.
 */
export function defaultLayout(schemas: Pick<TableSchema, "columns">[]): { x: number; y: number }[] {
  let top = 25;
  const positions: { x: number; y: number }[] = [];
  for (let start = 0; start < schemas.length; start += LAYOUT_COLUMNS) {
    const row = schemas.slice(start, start + LAYOUT_COLUMNS);
    row.forEach((_, column) => positions.push({ x: 30 + column * 300, y: top }));
    const tallest = Math.max(...row.map((s) => NODE_HEADER + s.columns.length * FIELD_HEIGHT));
    top += Math.max(MIN_ROW_HEIGHT, tallest) + ROW_GAP;
  }
  return positions;
}
