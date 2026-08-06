import type { ReactNode } from "react";
import { IconAlert } from "../primitives/icons";
import "./SurfaceState.css";

/**
 * Loading, error, and empty — drawn once, for every surface in this directory.
 *
 * Every component here owes these three states, and three components rendering
 * their own skeleton is three skeletons that drift: one pulses, one has four
 * bars, one forgets `aria-busy`. Worse, the error state is where copy quality
 * goes to die, and a shared component is a place to put the rule rather than a
 * place to hope.
 *
 * The rules it enforces:
 *
 *   - **An error says the word "Error".** Colour is never the only carrier of
 *     meaning (WCAG 1.4.1) and the audit pack this ends up inside is printed in
 *     black and white. The caller supplies what happened and what to do; this
 *     supplies the label and the mark.
 *   - **A skeleton is inert to assistive technology.** Bars are `aria-hidden`
 *     and the region is `aria-busy` with one screen-reader label, so a
 *     screen-reader user hears "loading" once instead of hearing four empty
 *     paragraphs.
 *   - **A skeleton does not pulse.** Six loading cards animating in sync is six
 *     things moving while the operator is trying to read the seventh.
 *   - **Precedence is error, then loading, then empty.** A surface that failed
 *     while refreshing shows the failure, not the spinner: the spinner says
 *     "wait" and waiting is exactly the wrong instruction.
 *
 * The 300ms rule from spec §7 — show nothing below it rather than a flash — is
 * the caller's, because only the caller knows when the request started.
 */

export interface SurfaceStateProps {
  readonly loading?: boolean;
  /** What happened, what it means, what to do. Never "Something went wrong". */
  readonly error?: ReactNode;
  /** Shown when there is no content and that is not a failure. */
  readonly empty?: ReactNode;
  readonly children?: ReactNode;
  /** How many skeleton bars. Match the shape of what is loading. */
  readonly skeletonLines?: number;
}

export function SurfaceState({
  loading = false,
  error,
  empty,
  children,
  skeletonLines = 3,
}: SurfaceStateProps) {
  if (error !== undefined && error !== null) {
    return (
      <div className="pv-surface-error">
        <p className="pv-surface-state-label">
          <IconAlert size="sm" />
          Error
        </p>
        <div className="pv-surface-state-detail">{error}</div>
      </div>
    );
  }

  if (loading) {
    const lines = Math.max(1, skeletonLines);
    return (
      <div className="pv-surface-loading" aria-busy="true">
        <span className="pv-sr-only">Loading</span>
        {Array.from({ length: lines }, (_unused, line) => (
          <span
            key={line}
            className="pv-surface-skeleton"
            aria-hidden="true"
            // Only the last bar is short, the way a paragraph's last line is.
            // Written as a data attribute so the widths stay in the stylesheet.
            data-line={line === lines - 1 && lines > 1 ? "last" : "full"}
          />
        ))}
      </div>
    );
  }

  const hasChildren = children !== undefined && children !== null && children !== false;
  if (!hasChildren && empty !== undefined && empty !== null) {
    return <div className="pv-surface-empty">{empty}</div>;
  }

  return <>{children}</>;
}
