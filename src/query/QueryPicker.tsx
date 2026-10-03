import { useId } from "react";
import { useDocumentConfig } from "../lib/config-store";

/** Select a saved query by id. `value` is the query id ("" for none). */
export function QueryPicker({
  value,
  onChange,
  label = "Query",
  allowNone = true,
  disabled,
}: {
  value: string | null | undefined;
  onChange: (queryId: string) => void;
  label?: string;
  allowNone?: boolean;
  disabled?: boolean;
}) {
  const { config } = useDocumentConfig();
  const id = useId();
  const queries = config.savedQueries ?? [];
  const missing = !!value && !queries.some((q) => q.id === value);
  return (
    <label className="query-picker" htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {allowNone && <option value="">No query</option>}
        {missing && <option value={value ?? ""}>Missing query</option>}
        {queries.map((q) => (
          <option key={q.id} value={q.id}>
            {q.name || "Untitled query"}
          </option>
        ))}
      </select>
    </label>
  );
}
