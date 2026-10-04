import { type ReactNode, useCallback, useState } from "react";
import { DialogFrame } from "../components/DialogFrame";

type Pending = { message: string; resolve: (ok: boolean) => void };

/**
 * In-app confirmation dialog: returns the dialog element and an async
 * `confirm(message)`. `fallbackFocus` receives focus on close when the opener
 * was removed (e.g. the Delete button of a deleted row).
 */
export function useConfirm(
  fallbackFocus?: () => HTMLElement | null | undefined,
): [ReactNode, (message: string) => Promise<boolean>] {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback(
    (message: string) => new Promise<boolean>((resolve) => setPending({ message, resolve })),
    [],
  );
  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  const element = pending ? (
    <ConfirmDialog message={pending.message} onClose={close} fallbackFocus={fallbackFocus} />
  ) : null;
  return [element, confirm];
}

function ConfirmDialog({
  message,
  onClose,
  fallbackFocus,
}: {
  message: string;
  onClose: (ok: boolean) => void;
  fallbackFocus?: () => HTMLElement | null | undefined;
}) {
  return (
    <DialogFrame
      className="rt-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirm"
      onClose={() => onClose(false)}
      fallbackFocus={fallbackFocus}
    >
      <p>{message}</p>
      <div className="rt-actions">
        <button type="button" onClick={() => onClose(false)}>
          Cancel
        </button>
        <button type="button" data-autofocus className="primary" onClick={() => onClose(true)}>
          Confirm
        </button>
      </div>
    </DialogFrame>
  );
}
