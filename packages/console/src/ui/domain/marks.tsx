import type { ReactNode } from "react";
import "./marks.css";

/**
 * The domain glyph set.
 *
 * `ui/primitives/icons.tsx` draws the marks the whole system shares — status,
 * chevrons, the padlock. These are the ones only this directory needs: the five
 * kinds of step on a run timeline, the three kinds of provenance, the direction
 * of a trend, and the three kinds of change in a diff. They live here rather
 * than in the primitive set because a glyph nobody outside this directory uses
 * is a glyph nobody outside this directory should have to read past.
 *
 * They are drawn to the same contract as the primitives, and for the same
 * reasons. Stroked paths in `currentColor` rather than a glyph font, because an
 * audit pack is printed and a font that falls back to a box takes away the
 * second channel a status depends on. `aria-hidden` and `focusable="false"`
 * without exception: a mark in this system is always beside a word, never
 * instead of one, so it has nothing to say to the accessibility tree.
 *
 * Two of these carry meaning that must survive a monochrome printout on shape
 * alone — the diff signs and the trend arrows. Both are drawn so that the shape
 * is unambiguous at 12px: an arrow that only differs from its opposite by
 * colour would fail exactly the reader this product has to serve.
 */

export interface MarkProps {
  /** `md` is 16px and `sm` is 12px — both from the spacing scale. */
  readonly size?: "sm" | "md";
  readonly className?: string;
}

function Mark({ size = "md", className, children }: MarkProps & { readonly children: ReactNode }) {
  return (
    <svg
      className={["pv-mark", size === "sm" ? "pv-mark-sm" : "", className ?? ""]
        .filter((part) => part.length > 0)
        .join(" ")}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* -----------------------------------------------------------------------------
   Timeline step kinds
   -------------------------------------------------------------------------- */

/** Retrieval — documents came back from a search. */
export function MarkRetrieval(props: MarkProps) {
  return (
    <Mark {...props}>
      <rect x="2.25" y="2.25" width="8.5" height="11.5" rx="1.5" />
      <path d="M4.75 5.5h3.5" />
      <path d="M4.75 8h3.5" />
      <path d="M13.75 4.75v8.5a.5.5 0 0 1-.5.5H6" />
    </Mark>
  );
}

/** A model step. A four-point spark, distinct from any status mark. */
export function MarkModel(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M8 1.75c.6 3.3 2.15 4.85 5.45 5.45-3.3.6-4.85 2.15-5.45 5.45-.6-3.3-2.15-4.85-5.45-5.45C5.85 6.6 7.4 5.05 8 1.75Z" />
      <path d="M12.75 11.5c.25 1.1.65 1.5 1.75 1.75-1.1.25-1.5.65-1.75 1.75-.25-1.1-.65-1.5-1.75-1.75 1.1-.25 1.5-.65 1.75-1.75Z" />
    </Mark>
  );
}

/** An action the platform took in the world — a write, a letter, a message. */
export function MarkAction(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M2.25 8h8.5" />
      <path d="M7.75 4.75 11 8l-3.25 3.25" />
      <path d="M13.25 2.75v10.5" />
    </Mark>
  );
}

/** A human step. Who did it and how long they took. */
export function MarkHuman(props: MarkProps) {
  return (
    <Mark {...props}>
      <circle cx="8" cy="5.25" r="2.5" />
      <path d="M3 13.25a5 5 0 0 1 10 0" />
    </Mark>
  );
}

/** A wait — parked, queued, or awaiting an approval that has not arrived. */
export function MarkWait(props: MarkProps) {
  return (
    <Mark {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.75V8l2.25 1.5" />
    </Mark>
  );
}

/* -----------------------------------------------------------------------------
   Provenance
   -------------------------------------------------------------------------- */

/** Retrieved — quoted from a source that exists outside this system. */
export function MarkRetrieved(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M4.25 9.75V7.5c0-1.5.9-2.6 2.5-3.25" />
      <path d="M2.25 9.75h4v3.5h-4z" />
      <path d="M11.75 9.75V7.5c0-1.5.9-2.6 2.5-3.25" />
      <path d="M9.75 9.75h4v3.5h-4z" />
    </Mark>
  );
}

/** Asserted — a person or a system stated it. Nothing derived it. */
export function MarkAsserted(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M3.75 13.75V2.75" />
      <path d="M3.75 3.25h8.5l-1.75 2.75L12.25 8.75h-8.5z" />
    </Mark>
  );
}

/** Computed — this system derived it, and the derivation can be shown. */
export function MarkComputed(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M3.25 6.25h9.5" />
      <path d="M3.25 9.75h9.5" />
      <path d="M6.5 2.75 5 13.25" />
      <path d="M11 2.75 9.5 13.25" />
    </Mark>
  );
}

/* -----------------------------------------------------------------------------
   Trend
   -------------------------------------------------------------------------- */

/**
 * Up, down, and flat. The three are separated by the direction of a
 * *diagonal*, not by a fill or a hue, so the difference survives a greyscale
 * printout and a monochrome display — which is the only reason a trend arrow is
 * allowed to sit beside a number at all.
 */
export function MarkTrendUp(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M3 11.5 6.75 7.75l2.5 2.5L13.25 6.25" />
      <path d="M9.75 6.25h3.5v3.5" />
    </Mark>
  );
}

export function MarkTrendDown(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M3 4.5 6.75 8.25l2.5-2.5L13.25 9.75" />
      <path d="M9.75 9.75h3.5v-3.5" />
    </Mark>
  );
}

export function MarkTrendFlat(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M2.75 8h10.5" />
    </Mark>
  );
}

/* -----------------------------------------------------------------------------
   Diff
   -------------------------------------------------------------------------- */

/** Added. A plus, which reads as an addition with no colour at all. */
export function MarkAdded(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M8 3.25v9.5" />
      <path d="M3.25 8h9.5" />
    </Mark>
  );
}

/** Removed. */
export function MarkRemoved(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M3.25 8h9.5" />
    </Mark>
  );
}

/** Changed — current becomes draft. */
export function MarkChanged(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M2.75 5.75h8.5" />
      <path d="M8.75 3.25 11.25 5.75 8.75 8.25" />
      <path d="M13.25 10.25h-8.5" />
      <path d="M7.25 7.75 4.75 10.25 7.25 12.75" />
    </Mark>
  );
}

/* -----------------------------------------------------------------------------
   Miscellany the domain components need
   -------------------------------------------------------------------------- */

/** Undo, on a toast that offers to take a decision back. */
export function MarkUndo(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M3.25 7.25h6.5a3.25 3.25 0 0 1 0 6.5H6.5" />
      <path d="M5.75 4.5 3 7.25l2.75 2.75" />
    </Mark>
  );
}

/** A filter, on the control that builds one. */
export function MarkFilter(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M2.25 3.75h11.5l-4.5 5v4.5l-2.5-1.5v-3z" />
    </Mark>
  );
}

/** Leaves the console. Marks a link that navigates away from the evidence. */
export function MarkExternal(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M9.25 2.75h4v4" />
      <path d="M13.25 2.75 7.5 8.5" />
      <path d="M12 9.75v2.75a.75.75 0 0 1-.75.75h-7.5a.75.75 0 0 1-.75-.75v-7.5a.75.75 0 0 1 .75-.75H6.5" />
    </Mark>
  );
}
