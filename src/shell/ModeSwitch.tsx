import { type ModeId, modes } from "./modes";

export function ModeSwitch({
  active,
  disabled,
  onChange,
  only,
}: {
  active: ModeId;
  disabled: boolean;
  onChange: (mode: ModeId) => void;
  /** Restricts the visible modes (runtime-only bundles show just Runtime). */
  only?: readonly ModeId[];
}) {
  return (
    <div className="mode-switch" role="group" aria-label="Document mode">
      {modes
        .filter(({ id }) => !only || only.includes(id))
        .map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={active === id ? "active" : ""}
            aria-pressed={active === id}
            disabled={disabled}
            onClick={() => onChange(id)}
          >
            <Icon aria-hidden="true" />
            {label}
          </button>
        ))}
    </div>
  );
}
