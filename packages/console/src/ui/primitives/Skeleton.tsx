import { useEffect, useState, type CSSProperties } from "react";
import { cx } from "./classes";
import { useReducedMotion } from "./motion";
import "./Skeleton.css";

/**
 * Skeleton — the shape of what is coming.
 *
 * The 300ms threshold from spec §7 lives in this component, not in its callers.
 * Every caller getting it right is not a thing that happens: one of them
 * forgets, that screen flashes grey bars on every cached response, and nobody
 * files it as a bug because it looks like the network being slow. Mounting this
 * is the whole contract — it decides for itself whether the wait is long enough
 * to be worth drawing.
 *
 * The box is reserved from the first frame and only the bars wait, which is how
 * both halves of §7 hold at once: no flash below the threshold, and no layout
 * shift when the content lands.
 *
 * Hidden from assistive technology by default. A screen reader user does not
 * need a description of grey rectangles; they need the one status message the
 * screen owns. Pass `label` where this skeleton *is* the only sign of the wait.
 */

/** Spec §7: below this, show nothing rather than a flash. */
export const SKELETON_DELAY_MS = 300;

export interface SkeletonProps {
  /** Text lines to draw. The last one is short, the way a paragraph ends. */
  readonly lines?: number;
  /** Any CSS length. Prefer one derived from a token over an invented number. */
  readonly width?: string;
  /** Per bar. Defaults to the body line height, so text-shaped by default. */
  readonly height?: string;
  readonly radius?: "control" | "card" | "pill";
  readonly delayMs?: number;
  /** Announced politely when the threshold passes. Silent when absent. */
  readonly label?: string;
  readonly className?: string;
}

export function Skeleton({
  lines = 3,
  width = "100%",
  height,
  radius = "control",
  delayMs = SKELETON_DELAY_MS,
  label,
  className,
}: SkeletonProps) {
  const [shown, setShown] = useState(delayMs <= 0);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (delayMs <= 0) return;
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);

  const barHeight = height ?? "var(--pv-type-body-line)";

  return (
    <>
      <div
        className={cx("pv-ui-skeleton", className)}
        data-shown={shown ? "true" : undefined}
        data-radius={radius}
        data-static={reducedMotion ? "true" : undefined}
        style={{ width } as CSSProperties}
        aria-hidden="true"
      >
        {Array.from({ length: Math.max(lines, 1) }, (_, index) => (
          <div
            key={index}
            className="pv-ui-skeleton-bar"
            style={{
              height: barHeight,
              // A paragraph's last line is short. Uniform bars read as a table,
              // which is a lie about what is loading.
              width: lines > 1 && index === lines - 1 ? "60%" : "100%",
            }}
          />
        ))}
      </div>
      {label !== undefined && shown && (
        <span className="pv-sr-only" role="status">
          {label}
        </span>
      )}
    </>
  );
}
