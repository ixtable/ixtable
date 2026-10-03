import { useId } from "react";
import { useDocumentConfig } from "../lib/config-store";

/** Select one of the document's actions. `value` is an action id; "" means none. */
export function ActionPicker({
  value,
  onChange,
  label = "Action",
  exclude,
  disabled,
}: {
  value: string | null | undefined;
  onChange: (actionId: string | null) => void;
  label?: string;
  /** Hide this action id (e.g. the action being edited). */
  exclude?: string;
  disabled?: boolean;
}) {
  const { config } = useDocumentConfig();
  const id = useId();
  const actions = config.actions.filter((a) => a.id !== exclude);
  return (
    <span className="action-picker">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">(none)</option>
        {actions.map((action) => (
          <option key={action.id} value={action.id}>
            {action.name || action.id}
          </option>
        ))}
        {value && !config.actions.some((a) => a.id === value) && (
          <option value={value}>Missing action ({value})</option>
        )}
      </select>
    </span>
  );
}
