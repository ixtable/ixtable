import { type InputHTMLAttributes, useEffect, useId, useState } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur"> & {
  value: string;
  // Applies the typed text; returns a problem to show (the draft is kept) or "" when applied.
  onCommit: (text: string) => string;
};

/**
 * An input edited as a local draft and applied on blur or Enter, so half-typed values
 * (an empty name, the "1" of "10") never reach the stored definition. Escape restores it.
 */
export function DraftInput({ value, onCommit, ...rest }: Props) {
  const [draft, setDraft] = useState(value);
  const [problem, setProblem] = useState("");
  const errorId = useId();
  useEffect(() => {
    setDraft(value);
    setProblem("");
  }, [value]);
  const commit = () => {
    if (draft === value) {
      setProblem("");
      return;
    }
    const next = onCommit(draft);
    setProblem(next);
    // A clamped value equal to the stored one would leave the typed text showing.
    if (!next) setDraft(value);
  };
  return (
    <>
      <input
        {...rest}
        value={draft}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? errorId : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value);
            setProblem("");
          }
        }}
      />
      {problem && (
        <span id={errorId} role="alert" className="fd-error">
          {problem}
        </span>
      )}
    </>
  );
}
