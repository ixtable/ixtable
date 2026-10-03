import { useEffect, useState } from "react";
import { useDocumentConfig } from "../lib/config-store";
import { runSavedQuery } from "../query/api";

/**
 * Result columns of a saved query, discovered by running it once (one row) with the
 * dashboard's filter defaults. Re-runs when the query or its SQL changes.
 */
export function useQueryColumns(
  queryId: string | null | undefined,
  params: Record<string, unknown>,
) {
  const { config } = useDocumentConfig();
  const sql = config.savedQueries.find((q) => q.id === queryId)?.sql ?? "";
  const key = JSON.stringify([queryId, sql, params]);
  const [state, setState] = useState<{ key: string; columns: string[]; error: string }>({
    key: "",
    columns: [],
    error: "",
  });
  useEffect(() => {
    const [id, , values] = JSON.parse(key) as [string | null, string, Record<string, unknown>];
    if (!id) return;
    let live = true;
    runSavedQuery(id, values, { limit: 1 })
      .then((result) => live && setState({ key, columns: result.columns, error: "" }))
      .catch(
        (reason) =>
          live && setState({ key, columns: [], error: String(reason?.message ?? reason) }),
      );
    return () => {
      live = false;
    };
  }, [key]);
  return state.key === key ? state : { key, columns: [], error: "" };
}
