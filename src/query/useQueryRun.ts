import { useCallback, useEffect, useRef, useState } from "react";
import { asTauriError } from "../lib/api";
import { newId } from "../lib/utils";
import { cancelQuery } from "./api";
import type { QueryRunResult } from "./types";

/** PRD §27.3: long queries expose progress and cancellation after 2 seconds. */
export const SLOW_QUERY_MS = 2000;

export interface QueryRunState {
  running: boolean;
  // True once the current run has taken longer than `SLOW_QUERY_MS`.
  slow: boolean;
  elapsed: number;
  result: QueryRunResult | null;
  error: string;
}

/**
 * Runs one query at a time with a run id, so a newer run (or `cancel`) interrupts
 * the previous one in DuckDB. Unmounting cancels a run still in flight.
 */
export function useQueryRun() {
  const [state, setState] = useState<QueryRunState>({
    running: false,
    slow: false,
    elapsed: 0,
    result: null,
    error: "",
  });
  const current = useRef<string | null>(null);
  const started = useRef(0);
  useEffect(() => {
    if (!state.running) return;
    const timer = setInterval(() => {
      const elapsed = Date.now() - started.current;
      setState((s) => ({ ...s, elapsed, slow: elapsed >= SLOW_QUERY_MS }));
    }, 250);
    return () => clearInterval(timer);
  }, [state.running]);
  useEffect(
    () => () => {
      if (current.current) cancelQuery(current.current).catch(() => undefined);
    },
    [],
  );
  const run = useCallback(async (exec: (runId: string) => Promise<QueryRunResult>) => {
    if (current.current) cancelQuery(current.current).catch(() => undefined);
    const runId = newId();
    current.current = runId;
    started.current = Date.now();
    setState((s) => ({ ...s, running: true, slow: false, elapsed: 0, error: "" }));
    try {
      const result = await exec(runId);
      if (current.current === runId)
        setState((s) => ({ ...s, result, error: "", running: false, slow: false }));
      return result;
    } catch (e) {
      const error = asTauriError(e);
      if (current.current === runId)
        setState((s) => ({
          ...s,
          result: null,
          running: false,
          slow: false,
          error: error.code === "CANCELLED" ? "Query cancelled." : error.message,
        }));
      return null;
    } finally {
      if (current.current === runId) current.current = null;
    }
  }, []);
  const cancel = useCallback(async () => {
    if (current.current) await cancelQuery(current.current);
  }, []);
  const reset = useCallback(() => {
    if (current.current) cancelQuery(current.current).catch(() => undefined);
    current.current = null;
    setState({ running: false, slow: false, elapsed: 0, result: null, error: "" });
  }, []);
  return { ...state, run, cancel, reset };
}
