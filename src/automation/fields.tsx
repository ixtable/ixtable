import { useId, useState } from "react";
import { check } from "../expr";

/** Root names an action or trigger expression may use. */
const SCOPE_NAMES = ["record", "old", "form", "app", "params", "results", "steps", "trigger"];

function expressionProblem(value: string | undefined, required: boolean): string | null {
  if (!value?.trim()) return required ? "Expression is required" : null;
  const [first] = check(value, SCOPE_NAMES);
  return first ? first.message : null;
}

/** Expression input with live `check()` diagnostics. */
export function ExprInput({
  label,
  value,
  onChange,
  required = false,
  placeholder,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const problem = expressionProblem(value, required);
  return (
    <div className="ax-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="ax-code"
        spellCheck={false}
        placeholder={placeholder}
        value={value ?? ""}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {problem && (
        <small id={`${id}-problem`} className="ax-problem">
          {problem}
        </small>
      )}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  list,
}: {
  label: string;
  value: string | number | undefined;
  onChange: (value: string) => void;
  list?: string;
}) {
  const id = useId();
  return (
    <div className="ax-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} list={list} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  none,
}: {
  label: string;
  value: T | undefined;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  /** Label of an empty first option, when choosing nothing is allowed. */
  none?: string;
}) {
  const id = useId();
  const missing = !!value && !options.some((o) => o.value === value);
  return (
    <div className="ax-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value as T)}>
        {(none !== undefined || !value) && <option value="">{none ?? "Choose…"}</option>}
        {missing && <option value={value}>Missing ({value})</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Edits a column/name → expression map. */
export function ValueMapEditor({
  label,
  value,
  onChange,
  keyLabel = "Column",
  columns,
}: {
  label: string;
  value: Record<string, string> | undefined;
  onChange: (value: Record<string, string>) => void;
  keyLabel?: string;
  columns?: string[];
}) {
  const listId = useId();
  const entries = Object.entries(value ?? {});
  const set = (next: [string, string][]) => onChange(Object.fromEntries(next));
  return (
    <fieldset className="ax-step" aria-label={label}>
      <legend>{label}</legend>
      {columns && (
        <datalist id={listId}>
          {columns.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      )}
      {entries.map(([key, expr], index) => (
        <div className="ax-kv" key={index}>
          <TextField
            label={`${keyLabel} ${index + 1}`}
            value={key}
            list={columns ? listId : undefined}
            onChange={(k) => set(entries.map((e, i) => (i === index ? [k, e[1]] : e)))}
          />
          <ExprInput
            label={`${key || `${keyLabel} ${index + 1}`} expression`}
            value={expr}
            required
            onChange={(x) => set(entries.map((e, i) => (i === index ? [e[0], x] : e)))}
          />
          <button
            type="button"
            aria-label={`Remove ${key || `${keyLabel} ${index + 1}`}`}
            onClick={() => set(entries.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          onClick={() => {
            let n = entries.length + 1;
            while (value && `${keyLabel.toLowerCase()}${n}` in value) n++;
            set([...entries, [`${keyLabel.toLowerCase()}${n}`, ""]]);
          }}
        >
          Add {keyLabel.toLowerCase()}
        </button>
      </div>
    </fieldset>
  );
}

/** Whole-number input that keeps what the user types and reports valid values only. */
export function NumberField({
  label,
  value,
  onChange,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    if (Number(text) !== value) setText(String(value));
  }
  const parsed = Number(text);
  const valid = text.trim() !== "" && Number.isInteger(parsed) && parsed >= min;
  return (
    <div className="ax-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        inputMode="numeric"
        value={text}
        aria-invalid={valid ? undefined : true}
        onChange={(e) => {
          setText(e.target.value);
          const next = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isInteger(next) && next >= min) onChange(next);
        }}
      />
      {!valid && <small className="ax-problem">Enter a whole number of at least {min}</small>}
    </div>
  );
}
