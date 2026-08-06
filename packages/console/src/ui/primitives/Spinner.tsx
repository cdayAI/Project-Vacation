import { cx } from "./classes";
import { useReducedMotion } from "./motion";
import "./Spinner.css";

/**
 * Spinner — an indeterminate wait.
 *
 * Two forms, and picking the wrong one is an accessibility defect either way:
 *
 * `decorative` — inside something that already announces the wait. A Button
 * with `loading` is already `aria-busy`, so a status region in the same button
 * would append "Loading" to its accessible name on every render.
 *
 * the default — the spinner *is* the announcement. It carries `role="status"`
 * and a screen-reader-only label, so it is spoken politely when it appears
 * rather than being a silent picture of activity.
 *
 * Note what this is not: a progress bar. This is for a wait whose length is
 * unknown. When the length is known, show the number — a spinner that has run
 * for eleven seconds looks exactly like one that has hung.
 */

export interface SpinnerProps {
  /** 12 / 16 / 24px. */
  readonly size?: "sm" | "md" | "lg";
  /** What is being waited for. Spoken, never drawn. */
  readonly label?: string;
  /** Hides it from assistive technology, for use inside a busy control. */
  readonly decorative?: boolean;
  readonly className?: string;
}

export function Spinner({
  size = "md",
  label = "Loading",
  decorative = false,
  className,
}: SpinnerProps) {
  const reducedMotion = useReducedMotion();

  return (
    <span
      className={cx("pv-ui-spinner", className)}
      data-size={size}
      data-static={reducedMotion ? "true" : undefined}
      role={decorative ? undefined : "status"}
      aria-hidden={decorative ? true : undefined}
    >
      <svg
        className="pv-ui-spinner-glyph"
        viewBox="0 0 16 16"
        fill="none"
        strokeWidth={2}
        aria-hidden="true"
        focusable="false"
      >
        <circle className="pv-ui-spinner-track" cx="8" cy="8" r="6" />
        <circle className="pv-ui-spinner-head" cx="8" cy="8" r="6" />
      </svg>
      {!decorative && <span className="pv-sr-only">{label}</span>}
    </span>
  );
}
