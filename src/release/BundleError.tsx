import type { TauriError } from "../lib/api";
import { bundleErrorText } from "./errors";

export function BundleError({ error }: { error: TauriError }) {
  const { summary, detail } = bundleErrorText(error);
  return (
    <div className="error bundle-error" role="alert">
      <b>{error.code}</b>
      <span>
        {summary}
        {detail && detail !== summary && <small> {detail}</small>}
      </span>
    </div>
  );
}
