import { useEffect, useState } from "react";
import { inspectTable } from "../../lib/api";
import type { DbObject, TableSchema } from "../../lib/types";

/** Column metadata for every table and view, keyed by name (for pickers and FK join suggestions). */
export function useSchemas(objects: DbObject[]): Record<string, TableSchema> {
  const [schemas, setSchemas] = useState<Record<string, TableSchema>>({});
  const names = objects
    .filter((o) => o.objectType === "table" || o.objectType === "view")
    .map((o) => o.name)
    .join("\n");
  useEffect(() => {
    let live = true;
    const list = names ? names.split("\n") : [];
    Promise.all(list.map((name) => inspectTable(name).catch(() => null))).then((found) => {
      if (!live) return;
      setSchemas(Object.fromEntries(found.flatMap((s) => (s ? [[s.name, s]] : []))));
    });
    return () => {
      live = false;
    };
  }, [names]);
  return schemas;
}

export const columnsOf = (schemas: Record<string, TableSchema>, table: string) =>
  schemas[table]?.columns.map((c) => c.name) ?? [];
