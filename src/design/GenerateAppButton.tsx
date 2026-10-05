import { Wand2 } from "lucide-react";
import { useState } from "react";
import { useGenerateApp } from "./generateApp";

/**
 * Call to action that generates forms and navigation for every table (or only `tables`)
 * still missing them, as one undoable step. Used in Run mode's empty state and in Data
 * mode after a table is created.
 */
export function GenerateAppButton({
  tables,
  label = "Generate app from tables",
  className,
  onDone,
}: {
  tables?: string[];
  label?: string;
  className?: string;
  onDone?: (added: number) => void;
}) {
  const generate = useGenerateApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    try {
      const added = await generate(tables);
      setError("");
      onDone?.(added);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={busy}
        onClick={() => run().catch(() => undefined)}
      >
        <Wand2 aria-hidden="true" />
        {label}
      </button>
      {error && (
        <small className="rt-error" role="alert">
          {error}
        </small>
      )}
    </>
  );
}
