import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { asTauriError, readDocumentConfig, type TauriError, updateDocumentConfig } from "./api";
import type { DocumentConfig, SessionState } from "./types";

type Entry = { config: DocumentConfig; label: string };
export interface UpdateOptions {
  /** false for navigation-only changes (mode switches) that should not enter undo history. */
  undoable?: boolean;
}

export interface DocumentConfigStore {
  config: DocumentConfig;
  update: (
    mutator: (draft: DocumentConfig) => DocumentConfig,
    label?: string,
    options?: UpdateOptions,
  ) => Promise<SessionState>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /**
   * Re-reads the config from Rust. With a label, records the external change as an
   * undo step. Without one (backend-owned changes such as DDL entity updates), no
   * undo step is added and the changed top-level fields are carried into the undo
   * history, so undoing an earlier edit does not revert the backend change.
   */
  reload: (label?: string) => Promise<DocumentConfig>;
  /**
   * Notes a SessionState produced outside the store. When its `configRevision` is
   * ahead of the revision the store last wrote or loaded, the next `update`
   * reloads first (without an undo step) so it does not overwrite that change.
   */
  observe: (state: SessionState) => void;
  /** Resolves once every queued `update` has reached Rust; await it before reading derived backend state. */
  settled: () => Promise<void>;
  error: TauriError | null;
}

const Context = createContext<DocumentConfigStore | null>(null);
const COALESCE_MS = 1000;
const HISTORY_LIMIT = 200;

const keepSessionFields = (snapshot: DocumentConfig, current: DocumentConfig): DocumentConfig => ({
  ...snapshot,
  activeMode: current.activeMode,
  navigationState: current.navigationState,
});

type Keyed = Record<string, unknown>;
/** Overwrites `keys` of a history snapshot with their values from `latest`. */
const carry = (
  snapshot: DocumentConfig,
  latest: DocumentConfig,
  keys: string[],
): DocumentConfig => {
  if (!keys.length) return snapshot;
  const out = { ...snapshot } as Keyed;
  for (const key of keys) out[key] = (latest as unknown as Keyed)[key];
  return out as unknown as DocumentConfig;
};
const changedKeys = (before: DocumentConfig, after: DocumentConfig): string[] => {
  const a = before as unknown as Keyed;
  const b = after as unknown as Keyed;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
  );
};

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement &&
    !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(target.type)
  );
};

/** Session-wide definition store: every config edit goes through `update`, which records undo history. */
export function DocumentConfigProvider({
  children,
  onState,
  fallback = null,
}: {
  children: ReactNode;
  onState?: (state: SessionState) => void;
  fallback?: ReactNode;
}) {
  const [config, setConfig] = useState<DocumentConfig | null>(null);
  const [past, setPast] = useState<Entry[]>([]);
  const [future, setFuture] = useState<Entry[]>([]);
  const [error, setError] = useState<TauriError | null>(null);
  const current = useRef<DocumentConfig | null>(null);
  const lastEdit = useRef<{ label: string; at: number } | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // configRevision the store last wrote or loaded, and the newest one seen anywhere.
  const revision = useRef(0);
  const seen = useRef(0);
  const onStateRef = useRef(onState);
  useEffect(() => {
    onStateRef.current = onState;
  });

  const persist = useCallback((next: DocumentConfig) => {
    current.current = next;
    setConfig(next);
    const pending = queue.current.then(() => updateDocumentConfig(next));
    queue.current = pending.catch(() => undefined);
    return pending.then(
      (state) => {
        setError(null);
        if (typeof state.configRevision === "number") {
          revision.current = state.configRevision;
          seen.current = Math.max(seen.current, state.configRevision);
        }
        onStateRef.current?.(state);
        return state;
      },
      (reason: unknown) => {
        setError(asTauriError(reason));
        throw reason;
      },
    );
  }, []);

  const reload = useCallback(async (label?: string) => {
    await queue.current;
    const previous = current.current;
    const loadedAt = seen.current;
    const next = await readDocumentConfig();
    revision.current = Math.max(revision.current, loadedAt);
    if (label && previous) {
      setPast((items) => [...items, { config: previous, label }].slice(-HISTORY_LIMIT));
      setFuture([]);
      lastEdit.current = null;
    } else if (previous) {
      const keys = changedKeys(previous, next);
      const rebase = (items: Entry[]) =>
        items.map((entry) => ({ ...entry, config: carry(entry.config, next, keys) }));
      if (keys.length) {
        setPast(rebase);
        setFuture(rebase);
        lastEdit.current = null;
      }
    }
    current.current = next;
    setConfig(next);
    return next;
  }, []);

  useEffect(() => {
    reload().catch((reason: unknown) => setError(asTauriError(reason)));
  }, [reload]);
  const settled = useCallback(async () => {
    await queue.current;
  }, []);
  const observe = useCallback((state: SessionState) => {
    if (typeof state.configRevision === "number")
      seen.current = Math.max(seen.current, state.configRevision);
  }, []);

  const update = useCallback<DocumentConfigStore["update"]>(
    function apply(mutator, label = "Edit", options = {}): Promise<SessionState> {
      // The backend changed the config since the store last wrote or loaded it:
      // load that first so this edit applies on top of it instead of overwriting it.
      if (seen.current > revision.current)
        return reload().then(() => apply(mutator, label, options));
      const previous = current.current;
      if (!previous) return Promise.reject(new Error("Document config is not loaded"));
      const next = mutator(structuredClone(previous));
      if (options.undoable !== false) {
        const now = Date.now();
        const coalesce =
          lastEdit.current?.label === label && now - lastEdit.current.at < COALESCE_MS;
        if (!coalesce)
          setPast((items) => [...items, { config: previous, label }].slice(-HISTORY_LIMIT));
        setFuture([]);
        lastEdit.current = { label, at: now };
      }
      return persist(next);
    },
    [persist, reload],
  );

  const travel = useCallback(
    async (back: boolean) => {
      const source = back ? past : future;
      let target = source.at(-1);
      const before = current.current;
      if (seen.current > revision.current) {
        const latest = await reload();
        // The history in this closure predates the reload's rebase; rebase the target here.
        if (target && before)
          target = { ...target, config: carry(target.config, latest, changedKeys(before, latest)) };
      }
      const present = current.current;
      if (!present || !target) return;
      const label = target.label;
      lastEdit.current = null;
      (back ? setPast : setFuture)((items) => items.slice(0, -1));
      (back ? setFuture : setPast)((items) => [...items, { config: present, label }]);
      await persist(keepSessionFields(target.config, present));
    },
    [past, future, persist, reload],
  );
  const undo = useCallback(() => travel(true), [travel]);
  const redo = useCallback(() => travel(false), [travel]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || isEditableTarget(event.target))
        return;
      const key = event.key.toLowerCase();
      const wantsRedo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
      if (key !== "z" && !wantsRedo) return;
      event.preventDefault();
      (wantsRedo ? redo() : undo()).catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const value = useMemo<DocumentConfigStore>(
    () => ({
      config: config as DocumentConfig,
      update,
      undo,
      redo,
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      undoLabel: past.at(-1)?.label ?? null,
      redoLabel: future.at(-1)?.label ?? null,
      reload,
      observe,
      settled,
      error,
    }),
    [config, update, undo, redo, past, future, reload, observe, settled, error],
  );
  if (!config) return <>{fallback}</>;
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDocumentConfig(): DocumentConfigStore {
  const store = useContext(Context);
  if (!store) throw new Error("useDocumentConfig must be used inside DocumentConfigProvider");
  return store;
}
