import { useCallback, useState } from "react";
import { newId } from "../lib/utils";
import { transferProgress } from "./api";
import type { TransferProgress } from "./types";

/** Polls Rust transfer progress while `run(transferId)` uploads or downloads. */
export function useTransfer() {
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const track = useCallback(async <T>(run: (transferId: string) => Promise<T>): Promise<T> => {
    const id = newId();
    const timer = setInterval(() => {
      transferProgress(id)
        .then((next) => {
          if (next) setProgress(next);
        })
        .catch(() => undefined);
    }, 300);
    try {
      return await run(id);
    } finally {
      clearInterval(timer);
      setProgress(null);
    }
  }, []);
  return { progress, track };
}

export const formatBytes = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
