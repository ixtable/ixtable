import { CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { asTauriError, type TauriError, validateDocument } from "../lib/api";
import { useDocumentConfig } from "../lib/config-store";
import type { Issue } from "../lib/types";

/** Lists `validate_document` issues; re-checks whenever the config changes. */
export function ProblemsTab() {
  const { config, settled } = useDocumentConfig();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<TauriError | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let current = true;
    settled()
      .then(validateDocument)
      .then((next) => {
        if (!current) return;
        setIssues(next);
        setError(null);
      })
      .catch((reason: unknown) => current && setError(asTauriError(reason)));
    return () => {
      current = false;
    };
  }, [config, revision, settled]);

  const errors = issues?.filter((issue) => issue.severity === "error").length ?? 0;
  return (
    <div className="settings-panel">
      <h2>Problems</h2>
      <div className="settings-actions">
        <span>
          {issues === null
            ? "Checking…"
            : `${errors} error${errors === 1 ? "" : "s"}, ${issues.length - errors} warning${
                issues.length - errors === 1 ? "" : "s"
              }`}
        </span>
        <button onClick={() => setRevision((value) => value + 1)}>Re-check</button>
      </div>
      {error && (
        <div className="error" role="alert">
          <b>{error.code}</b>
          <span>{error.message}</span>
        </div>
      )}
      {issues?.length === 0 && <p>No problems found.</p>}
      {!!issues?.length && (
        <ul className="problem-list" aria-label="Problems">
          {issues.map((issue, index) => (
            <li
              key={`${issue.objectKind}-${issue.objectId}-${index}`}
              className={`issue-${issue.severity}`}
            >
              {issue.severity === "error" ? (
                <CircleAlert aria-label="Error" />
              ) : (
                <TriangleAlert aria-label="Warning" />
              )}
              <span>
                <b>
                  {issue.objectKind} {issue.objectId}
                </b>
                {issue.message}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
