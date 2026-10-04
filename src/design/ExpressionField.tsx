import { useId } from "react";
import { expressionProblem } from "../runtime/formState";

/** Expression input with live `check()` diagnostics against the form's columns. */
export function ExpressionField({
  label,
  value,
  onChange,
  columns,
  names,
  placeholder,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  columns?: string[];
  /** Root names the expression may use, instead of the form scope. */
  names?: string[];
  placeholder?: string;
}) {
  const id = useId();
  const problem = expressionProblem(value, columns, names);
  return (
    <div className="fd-expr">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="fd-code"
        spellCheck={false}
        placeholder={placeholder}
        value={value ?? ""}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      />
      {problem && (
        <small id={`${id}-problem`} className="fd-problem" role="status">
          {problem}
        </small>
      )}
    </div>
  );
}
