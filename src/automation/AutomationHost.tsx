import { useEffect, useRef } from "react";
import { useDocumentConfig } from "../lib/config-store";
import { useShell } from "../shell/context";
import { browserContext, DATABASE_CHANGED_EVENT } from "./context";
import { installTriggers } from "./triggers";
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

  useEffect(
    () =>
      installTriggers({
        getConfig: () => configRef.current,
        context: (base) =>
          browserContext(configRef.current, (m, t) => notifyRef.current(m, t), base),
      }),
    [],
  );

  const polling = (config.triggers ?? []).some((t) => t.enabled && t.mode === "async");
  useEffect(
    () =>
      startWorker(
        {
          getConfig: () => configRef.current,
          onJob: () => window.dispatchEvent(new Event(DATABASE_CHANGED_EVENT)),
        },
        { intervalMs: polling ? 1000 : null },
      ),
    [polling],
  );
  return null;
}
