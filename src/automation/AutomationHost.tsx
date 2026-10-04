import { useEffect, useRef, useState } from "react";
import { useDocumentConfig } from "../lib/config-store";
import { authorizer } from "../runtime/rbac";
import { useShell } from "../shell/context";
import { browserContext, currentAppState, DATABASE_CHANGED_EVENT } from "./context";
import { installCustomActions } from "./custom";
import { hasQueuedJobs, JOBS_CHANGED_EVENT } from "./api";
import { installTriggers, type TriggerEnv } from "./triggers";
import { startWorker } from "./worker";

/**
 * Mounted by the shell while a document is open: installs the record-trigger hook
 * and runs the background job worker. Renders nothing.
 */
export function AutomationHost() {
  const { config } = useDocumentConfig();
  const { setNotice, setError } = useShell();
  const configRef = useRef(config);
  const notifyRef = useRef((message: string, tone?: "info" | "error") =>
    tone === "error" ? setError({ code: "ACTION", message }) : setNotice(message),
  );
  useEffect(() => {
    configRef.current = config;
    notifyRef.current = (message, tone) =>
      tone === "error" ? setError({ code: "ACTION", message }) : setNotice(message);
  });

  useEffect(() => {
    const env: TriggerEnv = {
      getConfig: () => configRef.current,
      app: currentAppState,
      // User-mode triggers and custom actions act as the user; app-mode triggers present their grant.
      context: (base) =>
        browserContext(configRef.current, (m, t) => notifyRef.current(m, t), {
          ...base,
          ...(!base.triggerAuth && { authorize: authorizer(configRef.current) }),
        }),
    };
    const uninstallTriggers = installTriggers(env);
    const uninstallCustom = installCustomActions(env);
    return () => {
      uninstallTriggers();
      uninstallCustom();
    };
  }, []);

  // Poll while an async trigger is enabled or jobs wait (also those of disabled or deleted triggers).
  const queued = useQueuedJobs();
  const polling = queued || (config.triggers ?? []).some((t) => t.enabled && t.mode === "async");
  useEffect(
    () =>
      startWorker(
        {
          getConfig: () => configRef.current,
          app: currentAppState,
          onJob: () => window.dispatchEvent(new Event(DATABASE_CHANGED_EVENT)),
        },
        { intervalMs: polling ? 1000 : null },
      ),
    [polling],
  );
  return null;
}

/** True while the open document's queue has queued or running jobs (rechecked on queue changes). */
function useQueuedJobs(): boolean {
  const [queued, setQueued] = useState(false);
  useEffect(() => {
    let live = true;
    const check = () => {
      hasQueuedJobs()
        .then((yes) => live && setQueued(yes))
        .catch(() => undefined);
    };
    check();
    window.addEventListener(JOBS_CHANGED_EVENT, check);
    const timer = setInterval(check, 30_000);
    return () => {
      live = false;
      window.removeEventListener(JOBS_CHANGED_EVENT, check);
      clearInterval(timer);
    };
  }, []);
  return queued;
}
