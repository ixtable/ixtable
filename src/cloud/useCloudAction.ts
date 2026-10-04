import { useState } from "react";
import { type CloudError, toCloudError } from "./errors";

/** Runs a cloud action with busy/error/notice state. */
export function useCloudAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CloudError | null>(null);
  const [notice, setNotice] = useState("");
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const message = await action();
      if (message) setNotice(message);
    } catch (reason) {
      setError(await toCloudError(reason));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, notice, run, setError, setNotice };
}
