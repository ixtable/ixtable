import { Check } from "lucide-react";
import { booleanValue } from "./values";

/** A yes/no list cell: a checkmark for yes, a dash for no, with "Yes"/"No" for assistive tech. */
export function BooleanCell({ value }: { value: unknown }) {
  const on = booleanValue(value);
  if (on === null) return null;
  return (
    <span className={on ? "rt-bool rt-bool-yes" : "rt-bool rt-bool-no"}>
      {on ? <Check aria-hidden="true" /> : <span aria-hidden="true">–</span>}
      <span className="sr-only">{on ? "Yes" : "No"}</span>
    </span>
  );
}
