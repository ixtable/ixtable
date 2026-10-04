import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

/** Event carrying `.ixt`/`.ixtr` paths a later launch (or the OS) asked this app to open. */
export const OPEN_FILES_EVENT = "ixtable://open-files";

/** Runtime bundles open through the bundle flow; everything else is a document. */
export const isRuntimeBundle = (path: string) => path.toLowerCase().endsWith(".ixtr");

/**
 * Calls `handler` with the paths of each open-files request. Returns an unsubscribe
 * function. Listening failures (no Tauri host, as in unit tests) are ignored.
 */
export function onOpenFiles(handler: (paths: string[]) => void): () => void {
  let active = true;
  let unlisten: (() => void) | null = null;
  listen<string[]>(OPEN_FILES_EVENT, (event) => {
    if (active && Array.isArray(event.payload)) handler(event.payload);
  })
    .then((stop) => {
      if (active) unlisten = stop;
      else stop();
    })
    .catch(() => undefined);
  return () => {
    active = false;
    unlisten?.();
  };
}

/** A file the OS asked the app to open (launch argument or a later launch). */
export type OpenRequest = { id: number; path: string };

/** Runs `effect` once per request id. */
export function useEachRequest(
  request: OpenRequest | null | undefined,
  effect: (request: OpenRequest) => void,
) {
  const seen = useRef(0);
  const latest = useRef(effect);
  useEffect(() => {
    latest.current = effect;
  });
  useEffect(() => {
    if (!request || request.id === seen.current) return;
    seen.current = request.id;
    latest.current(request);
  }, [request]);
}
