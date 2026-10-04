import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { newId } from "../lib/utils";
import { type ConditionalStyle, TONES, type Tone } from "../runtime/conditions";
import { ExpressionField } from "./ExpressionField";

const TONE_LABELS: Record<Tone, string> = {
  positive: "Positive",
  negative: "Negative",
  warning: "Warning",
  muted: "Muted",
  emphasis: "Emphasis",
};

/**
 * Ordered conditional style rules (first match wins). `names` are the scope names the
 * conditions may use; `columns`, when given, adds a column picker per rule (dashboard tables).
 */
export function StylesEditor({
  rules,
  onChange,
  names,
  columns,
}: {
  rules: ConditionalStyle[] | undefined;
  onChange: (rules: ConditionalStyle[]) => void;
  names: string[];
  columns?: string[];
}) {
  const list = rules ?? [];
  const patch = (index: number, next: Partial<ConditionalStyle>) =>
    onChange(list.map((rule, i) => (i === index ? { ...rule, ...next } : rule)));
  const move = (index: number, step: number) => {
    const next = [...list];
    const [rule] = next.splice(index, 1);
    next.splice(index + step, 0, rule);
    onChange(next);
  };
  return (
    <fieldset className="fd-fieldset">
      <legend>Conditional styles</legend>
      {!list.length && <p className="fd-hint">The first rule whose condition holds applies.</p>}
      {list.map((rule, index) => {
        const n = index + 1;
        return (
          <div key={rule.id} className="fd-style-rule" role="group" aria-label={`Style ${n}`}>
            {columns && (
              <label>
                Style {n} column
                <select
                  value={rule.column ?? ""}
                  onChange={(e) => patch(index, { column: e.target.value || null })}
                >
                  <option value="">—</option>
                  {rule.column && !columns.includes(rule.column) && (
                    <option value={rule.column}>{rule.column}</option>
                  )}
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <ExpressionField
              label={`Style ${n} when`}
              value={rule.when}
              names={names}
              placeholder="value < 0"
              onChange={(when) => patch(index, { when: when ?? "" })}
            />
            <label>
              Style {n} tone
              <select
                value={rule.tone}
                onChange={(e) => patch(index, { tone: e.target.value as Tone })}
              >
                {TONES.map((tone) => (
                  <option key={tone} value={tone}>
                    {TONE_LABELS[tone]}
                  </option>
                ))}
              </select>
            </label>
            <div className="fd-row">
              <button
                type="button"
                aria-label={`Move style ${n} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Move style ${n} down`}
                disabled={index === list.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Remove style ${n}`}
                onClick={() => onChange(list.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() =>
          onChange([
            ...list,
            { id: newId(), when: "", tone: "emphasis", ...(columns ? { column: null } : {}) },
          ])
        }
      >
        <Plus aria-hidden="true" />
        Add style
      </button>
    </fieldset>
  );
}
