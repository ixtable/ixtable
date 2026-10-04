import { useCallback, useEffect, useState } from "react";
import {
  asTauriError,
  closeDocument,
  openDocument,
  takeLaunchFiles,
  type TauriError,
} from "../lib/api";
import { isRuntimeBundle, onOpenFiles, type OpenRequest, useEachRequest } from "../lib/launch";
import type { SessionState } from "../lib/types";
import type { Autosave } from "../persistence/useAutosave";
import type { Doc } from "./context";

export const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

let nextRequest = 1;

/**
 * The pending open request: the file the app was launched with, then each
 * `ixtable://open-files` event. Only the first path of a request is opened.
 */
export function useOpenRequests() {
  const [request, setRequest] = useState<OpenRequest | null>(null);
  useEffect(() => {
    let active = true;
    const push = (paths: string[]) => {
      if (active && paths[0]) setRequest({ id: nextRequest++, path: paths[0] });
    };
    takeLaunchFiles()
      .then(push)
      .catch(() => undefined);
    const stop = onOpenFiles(push);
    return () => {
      active = false;
      stop();
    };
  }, []);
  const handled = useCallback(
    (id: number) => setRequest((current) => (current?.id === id ? null : current)),
    [],
  );
  return { request, handled };
}

/**
 * Opens a requested file over the open document. Unsaved changes are flushed by
 * autosave when possible, otherwise the user confirms discarding them. A runtime
 * bundle closes the document and stays pending for the start screen's bundle flow.
 */
export function useOpenRequestInShell(options: {
  request?: OpenRequest | null;
  onHandled?: (id: number) => void;
  onOpened?: (state: SessionState) => void;
  onClosed: () => void;
  doc: Doc;
  autosave: Autosave;
  applySession: (state: SessionState) => void;
  setPending: (label: string) => void;
  setError: (error: TauriError | null) => void;
  setNotice: (notice: string) => void;
}) {
  useEachRequest(options.request, (request) => {
    const { doc, autosave, applySession, setPending, setError, setNotice } = options;
    const bundle = isRuntimeBundle(request.path);
    const open = async () => {
      const flushed =
        doc.dirty && autosave.view.eligible ? await autosave.controller.flush() : null;
      if (flushed) applySession(flushed);
      const dirty = flushed ? flushed.dirty : doc.dirty;
      const target = fileName(request.path);
      if (dirty && !window.confirm(`Discard unsaved changes in ${doc.name} and open ${target}?`)) {
        options.onHandled?.(request.id);
        setNotice(`Kept ${doc.name} open; ${target} was not opened.`);
        return;
      }
      setPending(`Opening ${target}…`);
      setError(null);
      if (bundle) {
        await closeDocument(true);
        options.onClosed();
        return;
      }
      options.onHandled?.(request.id);
      options.onOpened?.(await openDocument(request.path));
    };
    open().catch((reason: unknown) => {
      options.onHandled?.(request.id);
      setError(asTauriError(reason));
      setPending("");
    });
  });
}
