import { type CloudError, cloudErrorSummary } from "./errors";

/** An alert for a failed cloud operation: plain-language summary plus the server detail. */
export function CloudErrorNotice({ error }: { error: Pick<CloudError, "code" | "message"> }) {
  const summary = cloudErrorSummary(error.code);
  return (
    <div className="error cloud-error" role="alert">
      <b>{error.code}</b>
      <span>
        {summary}
        {error.message && error.message !== summary && <small> {error.message}</small>}
      </span>
    </div>
  );
}
