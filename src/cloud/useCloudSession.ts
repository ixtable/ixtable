import { useEffect, useSyncExternalStore } from "react";
import { loadSession, sessionSnapshot, subscribeSession } from "./client";

/** The signed-in cloud session (null when signed out); loads the stored one on first use. */
export function useCloudSession() {
  const snapshot = useSyncExternalStore(subscribeSession, sessionSnapshot);
  useEffect(() => {
    if (!snapshot.ready) loadSession().catch(() => undefined);
  }, [snapshot.ready]);
  return snapshot;
}
