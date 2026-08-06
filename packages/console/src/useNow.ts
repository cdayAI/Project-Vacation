import { useEffect, useState } from "react";

/**
 * The current time, re-read on an interval.
 *
 * Used only for countdowns. It is a hook rather than a read of `Date.now()`
 * inside a render so that the value is stable within a render pass and the
 * component re-renders on a schedule we chose rather than whenever React
 * happens to re-run it.
 *
 * The ticking is not animation: nothing moves, a number changes. There is no
 * transition to suppress under `prefers-reduced-motion`, and the absolute
 * expiry time is always rendered alongside the countdown so the information is
 * available without waiting for a tick.
 */
export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);

  return now;
}
