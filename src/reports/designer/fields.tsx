import { useId } from "react";
import { check } from "../../expr";
import { REPORT_SCOPE_NAMES } from "../model";

/** Text input for a report expression with live `check()` diagnostics. */
export function ExpressionInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  const problems = value.trim() ? check(value, REPORT_SCOPE_NAMES) : [];
  return (
    <div className="report-expression">
      <label>
        {label}
        <input
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          aria-invalid={problems.length > 0}
          aria-describedby={problems.length ? id : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      {problems.length > 0 && (
        <span id={id} className="report-diagnostic" role="alert">
          {problems.map((p) => p.message).join("; ")}
        </span>
      )}
    </div>
  );
}

/** Number input in points; ignores empty or invalid entries. */
export function PointInput({
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
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        step={1}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n) && n >= min) onChange(n);
        }}
      />
    </label>
  );
}
