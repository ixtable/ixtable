import { useEffect, useState } from "react";

/** `value`, updated only after it has stayed the same for `ms` milliseconds. */
export function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}
