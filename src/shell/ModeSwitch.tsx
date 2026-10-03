import { type ModeId, modes } from "./modes";

export function ModeSwitch({
  active,
  disabled,
  onChange,
}: {
  active: ModeId;
  disabled: boolean;
  onChange: (mode: ModeId) => void;
}) {
  return (
    <div className="mode-switch" role="group" aria-label="Document mode">
      {modes.map(({ id, label, icon: Icon }) => (
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
