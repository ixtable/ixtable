import { type HTMLAttributes, type ReactNode, useEffect, useRef } from "react";

const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])";

/**
 * A dialog container that moves focus into itself when it opens (to the
 * `data-autofocus` element, else the first focusable one), closes on
 * Escape, and returns focus to the element that had it before (PRD §27.4).
 */
export function DialogFrame({
  onClose,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const node = panel.current;
    if (node && !node.contains(document.activeElement))
      (
        node.querySelector<HTMLElement>("[data-autofocus]") ??
        node.querySelector<HTMLElement>(FOCUSABLE)
      )?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      {...props}
      ref={panel}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {children}
    </div>
  );
}
