import { useEffect, useState } from "react";

/**
 * Whether the operator has asked their system for reduced motion.
 *
 * theme/motion.css already collapses every transition to an 80ms opacity fade,
 * which covers the whole system except one case: a component whose *meaning* is
 * carried by a keyframe animation. The blanket rule caps animations at 80ms and
 * a single iteration, so a spinner under reduced motion would turn a fifth of a
 * revolution and stop — an indicator that says "finished" while the request is
 * still in flight. Those components have to ask, and this is how they ask.
 *
 * `matchMedia` may be absent — jsdom, an embedded webview — and an absent
 * implementation is read as "no preference expressed" rather than as a request
 * for reduced motion, which matches how the theme preferences resolve.
 */

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => matchesReducedMotion());

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(matchesReducedMotion());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export function matchesReducedMotion(): boolean {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}
