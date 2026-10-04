import { writeLog } from "./api";

type Log = (level: "error", area: string, message: string) => Promise<unknown>;

/** One log line for an uncaught error or rejection reason (stack when there is one). */
export const describeCrash = (reason: unknown): string => {
  if (reason instanceof Error) return reason.stack || `${reason.name}: ${reason.message}`;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
};

/**
 * Captures uncaught errors and unhandled promise rejections into the local
 * diagnostic log (PRD §27.5; never uploaded, redacted in Rust). Returns an
 * uninstall function. Logging failures are swallowed so capture never recurses.
 */
export function installCrashCapture(target: Window = window, log: Log = writeLog): () => void {
  const send = (kind: string, reason: unknown) => {
    log("error", "crash", `${kind}: ${describeCrash(reason)}`).catch(() => undefined);
  };
  const onError = (e: ErrorEvent) =>
    send("uncaught error", e.error ?? `${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
  const onRejection = (e: PromiseRejectionEvent) => send("unhandled rejection", e.reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
