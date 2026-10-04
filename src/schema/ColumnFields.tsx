import type { ColumnDraft } from "./columns";
import { formatLogical, LOGICAL_TYPES, parseLogical } from "./logical";

/** One row of labelled controls for a column; `label` prefixes every accessible name. */
export function ColumnFields({
  draft,
  label,
  onChange,
  maxPrecision = 38,
  nameEditable = true,
}: {
  draft: ColumnDraft;
  label: string;
  onChange: (next: ColumnDraft) => void;
  maxPrecision?: number;
  nameEditable?: boolean;
}) {
  const parts = parseLogical(draft.logicalType);
  const set = (patch: Partial<ColumnDraft>) => onChange({ ...draft, ...patch });
  const setParts = (patch: Partial<typeof parts>) =>
    set({ logicalType: formatLogical({ ...parts, ...patch }) });
  return (
    <div className="column-design flex-wrap">
      {nameEditable && (
        <input
          aria-label={`${label} name`}
          placeholder="Column name"
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      )}
      <select
        aria-label={`${label} type`}
        value={parts.base}
        onChange={(e) =>
          setParts({ base: e.target.value, precision: Math.min(parts.precision, maxPrecision) })
        }
      >
        {LOGICAL_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      {parts.base === "decimal" && (
        <>
          <input
            type="number"
            min={1}
            max={maxPrecision}
            aria-label={`${label} precision`}
            className="w-20"
            value={parts.precision}
            onChange={(e) => setParts({ precision: Number(e.target.value) || 1 })}
          />
          <input
            type="number"
            min={0}
            max={parts.precision}
            aria-label={`${label} scale`}
            className="w-20"
            value={parts.scale}
            onChange={(e) => setParts({ scale: Number(e.target.value) || 0 })}
          />
        </>
      )}
      <label>
        <input
          type="checkbox"
          aria-label={`${label} required`}
          checked={draft.required}
          onChange={(e) => set({ required: e.target.checked })}
        />
        Required
      </label>
      <label>
        <input
          type="checkbox"
          aria-label={`${label} unique`}
          checked={draft.unique}
          onChange={(e) => set({ unique: e.target.checked })}
        />
        Unique
      </label>
      <input
        aria-label={`${label} default`}
        placeholder="Default (SQL literal)"
        value={draft.defaultExpression}
        onChange={(e) => set({ defaultExpression: e.target.value })}
      />
      <input
        aria-label={`${label} check`}
        placeholder="Check, e.g. qty > 0"
        value={draft.check}
        onChange={(e) => set({ check: e.target.value })}
      />
    </div>
  );
}
