import React, { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CloudError } from "@site/src/lib/cloud";

type Tone = "info" | "success" | "warning" | "danger";

export function Notice({
  tone = "info",
  title,
  children,
  testId,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  testId?: string;
}): ReactNode {
  const role = tone === "danger" ? "alert" : "status";
  return (
    <div className={`alert alert--${tone} cloud-notice`} role={role} data-testid={testId}>
      {title && <strong className="cloud-notice__title">{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

export function ErrorNotice({
  error,
  testId,
}: {
  error: CloudError | null;
  testId?: string;
}): ReactNode {
  if (!error) return null;
  return (
    <Notice tone="danger" testId={testId}>
      {error.message}
    </Notice>
  );
}

export function Loading({ label = "Loading" }: { label?: string }): ReactNode {
  return (
    <p className="cloud-muted" role="status" aria-live="polite">
      {label}...
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="cloud-empty">{children}</p>;
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone | "neutral";
  children: ReactNode;
}): ReactNode {
  return <span className={`cloud-badge cloud-badge--${tone}`}>{children}</span>;
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const id = useId();
  return (
    <section className="cloud-section" aria-labelledby={id}>
      <div className="cloud-section__head">
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p className="cloud-muted">{description}</p>}
        </div>
        {actions && <div className="cloud-section__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Horizontally scrollable wrapper so wide tables never widen the page on mobile. */
export function TableWrap({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="cloud-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="cloud-table">{children}</table>
    </div>
  );
}

/**
 * Modal confirmation built on the native <dialog>, which traps focus and closes on Escape.
 * When `confirmText` is set, the confirm button stays disabled until the user types it exactly.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  confirmText,
  danger = false,
  pending = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmText?: string;
  danger?: boolean;
  pending?: boolean;
  error?: CloudError | null;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const titleId = useId();
  const inputId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setTyped("");
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const blocked = confirmText !== undefined && typed !== confirmText;
  return (
    <dialog
      ref={ref}
      className="cloud-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <div className="cloud-dialog__body">{children}</div>
      {confirmText !== undefined && (
        <div className="cloud-field">
          <label htmlFor={inputId}>
            Type <code>{confirmText}</code> to confirm
          </label>
          <input
            id={inputId}
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
      )}
      <ErrorNotice error={error ?? null} />
      <div className="cloud-dialog__actions">
        <button type="button" className="button button--secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={`button ${danger ? "button--danger" : "button--primary"}`}
          disabled={blocked || pending}
          onClick={onConfirm}
        >
          {pending ? "Working..." : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

export interface TabDef {
  id: string;
  label: string;
}

/** WAI-ARIA tabs: arrow keys, Home, and End move between tabs. Selection is controlled. */
export function Tabs({
  tabs,
  selected,
  onSelect,
  label,
}: {
  tabs: TabDef[];
  selected: string;
  onSelect: (id: string) => void;
  label: string;
}): ReactNode {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    onSelect(tab.id);
    refs.current[tab.id]?.focus();
  };
  return (
    <div className="cloud-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          ref={(node) => {
            refs.current[tab.id] = node;
          }}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={selected === tab.id}
          aria-controls={`panel-${tab.id}`}
          tabIndex={selected === tab.id ? 0 : -1}
          className="cloud-tab"
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") move(index + 1);
            else if (event.key === "ArrowLeft") move(index - 1);
            else if (event.key === "Home") move(0);
            else if (event.key === "End") move(tabs.length - 1);
            else return;
            event.preventDefault();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }): ReactNode {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="cloud-panel">
      {children}
    </div>
  );
}
