import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Grid3X3, Redo2, Save, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  asTauriError,
  closeDocument,
  listDatabaseObjects,
  saveDocument,
  saveDocumentAs,
  type TauriError,
} from "../lib/api";
import { DocumentConfigProvider, useDocumentConfig } from "../lib/config-store";
import { chooseDocumentDestination } from "../lib/dialog";
import { AutomationHost } from "../automation/AutomationHost";
import type { DbObject, SessionState } from "../lib/types";
import { type Doc, type Selection, type ShellApi, ShellContext } from "./context";
import { ModeSwitch } from "./ModeSwitch";
import { findMode, type ModeId, modes } from "./modes";
import { SaveStatus } from "../persistence";
import { type Autosave, useAutosave } from "../persistence/useAutosave";
import { RuntimeBar } from "../release";

const fromSession = (state: SessionState): Doc => ({
  name: state.name,
  path: state.path ?? undefined,
  dirty: state.dirty,
  mode: state.runtimeOnly ? "run" : findMode(state.activeMode).id,
  sessionId: state.sessionId,
  documentId: state.documentId,
  runtimeOnly: !!state.runtimeOnly,
  bundleVersion: state.bundleVersion ?? null,
});

/** The open-document frame: sidebar, mode switch, ribbon, and the active mode's workspace. */
export function AppShell({ initial, onClosed }: { initial: SessionState; onClosed: () => void }) {
  const [doc, setDoc] = useState<Doc>(() => fromSession(initial));
  const adopt = useCallback((state: SessionState) => setDoc(fromSession(state)), []);
  const autosave = useAutosave(adopt, initial);
  const applySession = useCallback(
    (state: SessionState) => {
      setDoc(fromSession(state));
      autosave.controller.sync(state);
    },
    [autosave.controller],
  );
  return (
    <DocumentConfigProvider
      onState={applySession}
      fallback={<div className="document-app">Opening {doc.name}…</div>}
    >
      <ShellFrame
        doc={doc}
        setDoc={setDoc}
        applySession={applySession}
        onClosed={onClosed}
        autosave={autosave}
      />
    </DocumentConfigProvider>
  );
}

function ShellFrame({
  doc,
  setDoc,
  applySession: applyState,
  onClosed,
  autosave,
}: {
  doc: Doc;
  setDoc: (update: (doc: Doc) => Doc) => void;
  applySession: (state: SessionState) => void;
  onClosed: () => void;
  autosave: Autosave;
}) {
  const store = useDocumentConfig();
  const { observe } = store;
  // States from commands outside the config store may carry backend config changes.
  const applySession = useCallback(
    (state: SessionState) => {
      applyState(state);
      observe(state);
    },
    [applyState, observe],
  );
  const [pending, setPending] = useState("");
  const [error, setError] = useState<TauriError | null>(null);
  const [notice, setNotice] = useState("");
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [metadataError, setMetadataError] = useState("");
  const [selection, select] = useState<Selection | null>(null);
  const [dismissed, setDismissed] = useState<TauriError | null>(null);

  const reloadMetadata = useCallback(async () => {
    setMetadataLoading(true);
    setMetadataError("");
    try {
      setObjects(await listDatabaseObjects());
    } catch (reason) {
      setMetadataError(asTauriError(reason).message);
    } finally {
      setMetadataLoading(false);
    }
  }, []);
  useEffect(() => {
    reloadMetadata().catch(() => undefined);
  }, [doc.mode, reloadMetadata]);
  useEffect(() => {
    const reload = () => {
      reloadMetadata().catch(() => undefined);
    };
    window.addEventListener("ixtable:database-changed", reload);
    return () => window.removeEventListener("ixtable:database-changed", reload);
  }, [reloadMetadata]);
  useEffect(() => {
    document.title = `${doc.name}${doc.dirty ? " •" : ""} — ixtable`;
    return () => {
      document.title = "ixtable";
    };
  }, [doc.name, doc.dirty]);

  const markDirty = useCallback(() => {
    setDoc((d) => ({ ...d, dirty: true }));
    autosave.controller.touch();
  }, [setDoc, autosave.controller]);
  const changeMode = useCallback(
    async (mode: ModeId) => {
      if (doc.mode === mode) return;
      setPending(`Switching to ${findMode(mode).label} mode…`);
      setError(null);
      try {
        await store.update((draft) => ({ ...draft, activeMode: mode }), "Switch mode", {
          undoable: false,
        });
      } catch (reason) {
        setError(asTauriError(reason));
      } finally {
        setPending("");
      }
    },
    [doc.mode, store],
  );
  const save = useCallback(
    async (forceDestination = false) => {
      setPending("Saving document…");
      setError(null);
      setNotice("");
      try {
        if (forceDestination || !doc.path) {
          const path = await chooseDocumentDestination(doc.name);
          if (!path) {
            setNotice("Save canceled.");
            return;
          }
          applySession(await saveDocumentAs(path));
        } else {
          applySession(await saveDocument());
        }
      } catch (reason) {
        setError(asTauriError(reason));
      } finally {
        setPending("");
      }
    },
    [doc.path, doc.name, applySession],
  );
  const close = async () => {
    const flushed = doc.dirty && autosave.view.eligible ? await autosave.controller.flush() : null;
    if (flushed) applySession(flushed);
    const dirty = flushed ? flushed.dirty : doc.dirty;
    const discard = dirty
      ? window.confirm("Discard unsaved changes and close this document?")
      : false;
    if (dirty && !discard) return;
    setPending("Closing document…");
    setError(null);
    try {
      await closeDocument(discard);
      onClosed();
    } catch (reason) {
      setError(asTauriError(reason));
      setPending("");
    }
  };

  const shell = useMemo<ShellApi>(
    () => ({
      doc,
      pending,
      objects,
      metadataLoading,
      metadataError,
      reloadMetadata,
      selection,
      select,
      markDirty,
      applySession,
      setNotice,
      setError,
      save,
      changeMode,
    }),
    [
      doc,
      pending,
      objects,
      metadataLoading,
      metadataError,
      reloadMetadata,
      selection,
      markDirty,
      applySession,
      save,
      changeMode,
    ],
  );
  const mode = findMode(doc.mode);
  const shownError = error ?? (store.error === dismissed ? null : store.error);
  const run = (action: () => Promise<unknown>) => {
    action().catch((reason: unknown) => setError(asTauriError(reason)));
  };

  return (
    <ShellContext.Provider value={shell}>
      <AutomationHost />
      <div className="document-app">
        <aside className="doc-sidebar">
          <div className="doc-brand">
            <span>ix</span>
            <div className="project-actions">
              {!doc.runtimeOnly && (
                <>
                  <button aria-label="Save project" disabled={!!pending} onClick={() => save()}>
                    <Save />
                  </button>
                  <button
                    aria-label="Save project as"
                    disabled={!!pending}
                    onClick={() => save(true)}
                  >
                    <Save />
                  </button>
                </>
              )}
              <button aria-label="Close project" disabled={!!pending} onClick={close}>
                <X />
              </button>
            </div>
          </div>
          {doc.runtimeOnly ? (
            <RuntimeBar />
          ) : (
            <div className="document-label">
              <small>PROJECT</small>
              <strong>{doc.name}</strong>
              <span>{doc.path ? "Saved archive" : "Not saved yet"}</span>
            </div>
          )}
          <ModeSwitch
            active={doc.mode}
            disabled={!!pending}
            onChange={changeMode}
            only={doc.runtimeOnly ? ["run"] : undefined}
          />
          {mode.Sidebar && <mode.Sidebar />}
          <SaveStatus autosave={autosave} hasPath={!!doc.path} />
        </aside>
        <main className={`workspace ${mode.workspaceClassName ?? ""}`}>
          <div className="ribbon-tabs">
            <button className="active">Home</button>
          </div>
          <section className="ribbon" aria-label="Workspace">
            <div className="ribbon-group view-group">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="ribbon-big">
                    <Grid3X3 />
                    <span>{mode.label} view</span>
                    <ChevronDown />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="view-menu" sideOffset={6}>
                    <DropdownMenu.Label>Switch view</DropdownMenu.Label>
                    {modes
                      .filter((item) => !doc.runtimeOnly || item.id === "run")
                      .map((item) => (
                        <DropdownMenu.Item
                          key={item.id}
                          onSelect={() => run(() => changeMode(item.id))}
                          className={doc.mode === item.id ? "checked" : ""}
                        >
                          {item.label} view
                          <span>{doc.mode === item.id ? "✓" : ""}</span>
                        </DropdownMenu.Item>
                      ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              <small>View</small>
            </div>
            <div className="ribbon-group">
              <div className="ribbon-tools">
                <button
                  aria-label="Undo"
                  title={store.undoLabel ? `Undo ${store.undoLabel} (Ctrl+Z)` : "Undo (Ctrl+Z)"}
                  disabled={!store.canUndo}
                  onClick={() => run(store.undo)}
                >
                  <Undo2 />
                  <span>Undo</span>
                </button>
                <button
                  aria-label="Redo"
                  title={
                    store.redoLabel
                      ? `Redo ${store.redoLabel} (Ctrl+Shift+Z)`
                      : "Redo (Ctrl+Shift+Z)"
                  }
                  disabled={!store.canRedo}
                  onClick={() => run(store.redo)}
                >
                  <Redo2 />
                  <span>Redo</span>
                </button>
              </div>
              <small>History</small>
            </div>
          </section>
          {pending && (
            <div className="progress" role="status">
              {pending}
            </div>
          )}
          {shownError && (
            <div className="error" role="alert">
              <b>{shownError.code}</b>
              <span>{shownError.message}</span>
              <button
                aria-label="Dismiss error"
                onClick={() => {
                  setError(null);
                  setDismissed(store.error);
                }}
              >
                <X />
              </button>
            </div>
          )}
          {notice && (
            <div className="notice">
              <span>{notice}</span>
              <button aria-label="Dismiss" onClick={() => setNotice("")}>
                <X />
              </button>
            </div>
          )}
          <mode.Component />
        </main>
      </div>
    </ShellContext.Provider>
  );
}
