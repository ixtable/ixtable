import { useContext, useEffect, useRef } from "react";
import { type RevealTarget, ShellContext } from "./context";

type TargetFor<M extends RevealTarget["mode"]> = Extract<RevealTarget, { mode: M }>;

/**
 * Opens the object a Problems link (or another caller) asked `mode` to show, then clears
 * the request. Works outside the shell too (no request ever arrives there).
 */
export function useReveal<M extends RevealTarget["mode"]>(
  mode: M,
  handle: (target: TargetFor<M>) => void,
) {
  const shell = useContext(ShellContext);
  const handler = useRef(handle);
  useEffect(() => {
    handler.current = handle;
  });
  const target = shell?.reveal;
  const clear = shell?.clearReveal;
  useEffect(() => {
    if (!target || target.mode !== mode) return;
    handler.current(target as TargetFor<M>);
    clear?.();
  }, [target, mode, clear]);
}
