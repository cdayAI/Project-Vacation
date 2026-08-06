import type { ReactNode } from "react";
import type { Tone } from "./Badge";

export interface CalloutProps {
  readonly tone?: Tone;
  /** Rendered in bold as the first line, and always present. */
  readonly title: string;
  readonly children?: ReactNode;
  /**
   * Announce the callout when it appears. Use "polite" for something the
   * operator should hear about but not be interrupted for; leave unset for
   * content that was on the page from the start.
   *
   * Never "assertive" for anything routine — assertive interrupts whatever the
   * screen reader was saying, which is right for "your session has expired"
   * and wrong for everything else in this console.
   */
  readonly live?: "polite" | "assertive";
}

/**
 * A tone-carrying block of prose.
 *
 * The title is a paragraph in bold rather than a heading: callouts appear in
 * the middle of a view, and slotting an h3 in between an h2 and its real h3
 * would corrupt the heading outline that screen-reader users navigate by.
 */
export function Callout({ tone = "info", title, children, live }: CalloutProps) {
  return (
    <div
      className={`pv-callout pv-callout-${tone}`}
      role={live === undefined ? undefined : "status"}
      aria-live={live}
    >
      <p className="pv-callout-title">{title}</p>
      {children}
    </div>
  );
}
