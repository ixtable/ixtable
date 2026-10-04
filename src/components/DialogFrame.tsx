import { type HTMLAttributes, type ReactNode, useEffect, useRef } from "react";

const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])";

function focusables(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[hidden], [inert], [aria-hidden='true']"),
  );
}

/**
 * A dialog container that moves focus into itself when it opens (to the
 * `data-autofocus` element, else the first focusable one), keeps Tab and
 * Shift+Tab inside it, closes on Escape unless `busy`, and returns focus to
 * the element that had it before, or to `fallbackFocus` when that element is
 * gone (PRD §27.4).
 */
export function DialogFrame({
  onClose,
  busy,
  fallbackFocus,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  onClose: () => void;
  busy?: boolean;
  fallbackFocus?: () => HTMLElement | null | undefined;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const fallback = useRef(fallbackFocus);
  useEffect(() => {
    fallback.current = fallbackFocus;
  });
  useEffect(() => {
    const previous = document.activeElement;
    const node = panel.current;
    if (node && !node.contains(document.activeElement))
      (node.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(node)[0])?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
        return;
      }
      // Deferred so the caller's state update (e.g. removing a deleted row) has rendered.
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        fallback.current?.()?.focus();
      });
    };
  }, []);
  return (
    <div
      {...props}
      ref={panel}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.stopPropagation();
          if (!busy) onClose();
          return;
        }
        if (event.key !== "Tab" || !panel.current) return;
        const items = focusables(panel.current);
        if (items.length === 0) {
          event.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      {children}
    </div>
  );
}
