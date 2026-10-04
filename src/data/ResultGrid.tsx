import { Code2, Rows3 } from "lucide-react";
import type { QueryResult } from "../lib/types";
import { showValue } from "./format";

export function ResultGrid({
  result,
  cellClass,
}: {
  result: QueryResult | null;
  // Optional class per cell (row and column index), e.g. a conditional style tone.
  cellClass?: (row: number, column: number) => string | undefined;
}) {
  if (!result)
    return (
      <div className="empty-recent">
        <Code2 />
        <b>Run a query to see results</b>
      </div>
    );
  return (
    <div className="data-grid">
      <table>
        <thead>
          <tr>
            {result.columns.map((c, i) => (
              <th key={`${c}-${i}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} className={cellClass?.(i, j)}>
                  {showValue(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!result.rows.length && (
        <div className="empty-recent">
          <Rows3 />
          <b>Query returned no rows</b>
        </div>
      )}
    </div>
  );
}
