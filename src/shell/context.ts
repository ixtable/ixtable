import { createContext, useContext } from "react";
import type { TauriError } from "../lib/api";
import type { DbObject, SessionState } from "../lib/types";
import type { ModeId } from "./modes";

export type Doc = {
  name: string;
  path?: string;
  dirty: boolean;
  mode: ModeId;
  sessionId: string;
  documentId: string;
};

export type Selection = {
  kind: "table" | "view" | "query" | "new-query" | "new-table";
  id: string;
};

/** Document-level shell state shared with every mode component via `useShell()`. */
export interface ShellApi {
  doc: Doc;
  pending: string;
  objects: DbObject[];
  metadataLoading: boolean;
  metadataError: string;
  reloadMetadata: () => Promise<void>;
  selection: Selection | null;
  select: (selection: Selection | null) => void;
  markDirty: () => void;
  /** Adopts a SessionState returned by a command (name, path, dirty, mode). */
  applySession: (state: SessionState) => void;
  setNotice: (notice: string) => void;
  setError: (error: TauriError | null) => void;
  save: (forceDestination?: boolean) => Promise<void>;
  changeMode: (mode: ModeId) => Promise<void>;
}

export const ShellContext = createContext<ShellApi | null>(null);

export function useShell(): ShellApi {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell must be used inside the document shell");
  return shell;
}
