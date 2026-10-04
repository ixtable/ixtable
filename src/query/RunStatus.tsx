import { CircleStop, LoaderCircle } from "lucide-react";
import { ResultGrid } from "../data/ResultGrid";
import type { useQueryRun } from "./useQueryRun";

/** Progress line for a run: spinner, elapsed time and Cancel after 2s, then row counts. */
export function RunStatus({
  run,
  label = "Query",
}: {
  run: ReturnType<typeof useQueryRun>;
  label?: string;
}) {
  if (run.running)
    return (
      <div className="query-status" role="status">
        <LoaderCircle className="spin" aria-hidden />
        <span>
          Running {label.toLowerCase()}…{run.slow && ` ${Math.floor(run.elapsed / 1000)}s`}
        </span>
        {run.slow && (
          <>
            <progress aria-label={`${label} progress`} />
            <button type="button" onClick={() => void run.cancel()}>
              <CircleStop />
              Cancel query
            </button>
          </>
        )}
      </div>
    );
  if (run.error)
    return (
      <div className="error" role="alert">
        {run.error}
      </div>
    );
  if (!run.result) return null;
  const { rows, truncated, rowLimit, elapsedMs } = run.result;
  return (
    <div className="query-status">
      <span>
        {truncated
          ? `First ${rowLimit.toLocaleString()} rows`
          : `${rows.length.toLocaleString()} ${rows.length === 1 ? "row" : "rows"}`}{" "}
        · {elapsedMs.toLocaleString()} ms
      </span>
    </div>
  );
}

export function RunResults({ run }: { run: ReturnType<typeof useQueryRun> }) {
  return (
    <>
      <RunStatus run={run} />
      {run.result && <ResultGrid result={run.result} />}
    </>
  );
}
