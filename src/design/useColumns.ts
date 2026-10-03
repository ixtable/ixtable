import { useEffect, useState } from "react";
import { tableSchema } from "../runtime/data";

/** Column names of a table (cached schema reads); empty while loading or unknown. */
export function useColumns(table?: string | null): string[] {
  const [columns, setColumns] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    if (!table) {
      setColumns([]);
      return;
    }
    tableSchema(table)
      .then((schema) => live && setColumns(schema.columns.map((c) => c.name)))
      .catch(() => live && setColumns([]));
    return () => {
      live = false;
    };
  }, [table]);
  return columns;
}
