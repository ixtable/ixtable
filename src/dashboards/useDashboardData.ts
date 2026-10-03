import { useCallback, useEffect, useRef, useState } from "react";
import { asTauriError } from "../lib/api";
import { newId } from "../lib/utils";
import { cancelQuery, runSavedQuery } from "../query/api";
import type { QueryRunResult } from "../query/types";
import { SLOW_QUERY_MS } from "../query/useQueryRun";

export type QueryState =
  | { status: "loading"; result?: QueryRunResult }
  | { status: "ready"; result: QueryRunResult }
  | { status: "error" | "cancelled"; error: string }
  // The previewed role may not read this query; it is not run.
  | { status: "denied" };

/**
 * Runs every saved query a dashboard uses, in parallel, with the dashboard parameters.
 * Each query runs once even when several components share it. A new parameter set (or
 * `refresh`) cancels runs still in flight. Exposes progress and `cancel` once a load has
 * taken longer than `SLOW_QUERY_MS` (PRD §27.3).
 */
export function useDashboardData(queryIds: string[], params: Record<string, unknown>) {
  const [states, setStates] = useState<Record<string, QueryState>>({});
  const [version, setVersion] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const runs = useRef(new Map<string, string>());
  const key = JSON.stringify([queryIds, params]);

  useEffect(() => {
    let live = true;
    const ids: string[] = JSON.parse(key)[0];
    const values: Record<string, unknown> = JSON.parse(key)[1];
    const started = Date.now();
    setElapsed(0);
    setStates((current) =>
      Object.fromEntries(
        ids.map((id) => {
          const previous = current[id];
          return [
            id,
            {
              status: "loading",
              result: previous && "result" in previous ? previous.result : undefined,
            },
          ];
        }),
      ),
    );
    const timer = setInterval(() => setElapsed(Date.now() - started), 250);
    const mine = new Map<string, string>();
    const settle = (id: string, state: QueryState) => {
      if (live) setStates((current) => ({ ...current, [id]: state }));
    };
    Promise.all(
      ids.map(async (id) => {
        const runId = newId();
        mine.set(id, runId);
        runs.current.set(id, runId);
        try {
          settle(id, { status: "ready", result: await runSavedQuery(id, values, { runId }) });
        } catch (reason) {
          const error = asTauriError(reason);
          settle(
            id,
            error.code === "CANCELLED"
              ? { status: "cancelled", error: "Query cancelled." }
              : { status: "error", error: error.message },
          );
        } finally {
          if (runs.current.get(id) === runId) runs.current.delete(id);
          mine.delete(id);
        }
      }),
    ).finally(() => clearInterval(timer));
    return () => {
      live = false;
      clearInterval(timer);
      for (const runId of mine.values()) cancelQuery(runId).catch(() => undefined);
    };
  }, [key, version]);

  const cancel = useCallback(async () => {
    await Promise.all([...runs.current.values()].map((runId) => cancelQuery(runId).catch(() => 0)));
  }, []);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const pending = queryIds.filter((id) => (states[id]?.status ?? "loading") === "loading").length;
  return {
    states,
    pending,
    total: queryIds.length,
    elapsed,
    slow: pending > 0 && elapsed >= SLOW_QUERY_MS,
    cancel,
    refresh,
  };
}
