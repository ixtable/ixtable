import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

type Pending = { message: string; resolve: (ok: boolean) => void };

/** In-app confirmation dialog: returns the dialog element and an async `confirm(message)`. */
export function useConfirm(): [ReactNode, (message: string) => Promise<boolean>] {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback(
    (message: string) => new Promise<boolean>((resolve) => setPending({ message, resolve })),
    [],
  );
  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  const element = pending ? <ConfirmDialog message={pending.message} onClose={close} /> : null;
  return [element, confirm];
}

function ConfirmDialog({ message, onClose }: { message: string; onClose: (ok: boolean) => void }) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => ok.current?.focus(), []);
  return (
    <div
      className="rt-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirm"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose(false);
      }}
    >
      <p>{message}</p>
      <div className="rt-actions">
        <button type="button" onClick={() => onClose(false)}>
          Cancel
        </button>
        <button type="button" ref={ok} className="primary" onClick={() => onClose(true)}>
          Confirm
        </button>
      </div>
    </div>
  );
}
