import type { ReactNode } from "react";
import { IconAlert, IconCross } from "../primitives/icons";
import "./ErrorState.css";

/**
 * Something failed, and here is what to do about it.
 *
 * Spec §6 gives the shape and this component makes it structural rather than
 * advisory, because free-form error copy degrades into "Something went wrong"
 * within a quarter on every product that allows it. Four required parts, three
 * of them separate props so that a caller who leaves one out is writing an
 * error the type system rejects:
 *
 *   **What happened** — in the platform's voice, naming the system that failed.
 *     "We could not reach the loan servicing system."
 *   **What it means** — for the operator's work, right now. "Your work is
 *     saved." An error that does not say this makes people redo work.
 *   **What to do** — the sentence, and then the controls that do it.
 *   **A reference** — required. It is the first thing support asks for, and an
 *     operator reading it off a screenshot is the difference between a
 *     five-minute ticket and a forty-minute one.
 *
 * The banned copy is banned by convention rather than by code: "Oops",
 * "Something went wrong", "Invalid input", a raw stack trace, and anything that
 * blames the operator. A runtime check would be a string blocklist that a
 * paraphrase walks straight past, and the real enforcement is review.
 *
 * The word "Error" is on the screen, not only in the colour. This block ends up
 * in screenshots pasted into tickets and in printed audit packs, and both of
 * those are monochrome.
 */

export interface ErrorStateProps {
  /** What happened, naming the system. Never "Something went wrong". */
  readonly title: string;
  /** What it means for their work. "Your work is saved." */
  readonly meaning?: ReactNode;
  /** What to do, in words. The controls that do it go in `actions`. */
  readonly guidance?: ReactNode;
  /**
   * The reference code. Required, because "which error" is the first question
   * anyone asks and an operator cannot answer it from a screenshot otherwise.
   */
  readonly reference: string;
  readonly actions?: ReactNode;
  /**
   * `danger` is a failure; `warning` is a degraded state the operator can
   * continue through — a stale cache, a partial result.
   */
  readonly tone?: "danger" | "warning";
  /** Announced politely when it appears mid-flow. Omit for a state present at load. */
  readonly live?: boolean;
  /** Document structure, not size. Match the surrounding outline. */
  readonly headingLevel?: 2 | 3 | 4;
  readonly align?: "start" | "center";
  readonly className?: string;
}

/** The word beside the mark. Colour is never the only carrier of the state. */
const WORDS = { danger: "Error", warning: "Degraded" } as const;

export function ErrorState({
  title,
  meaning,
  guidance,
  reference,
  actions,
  tone = "danger",
  live = false,
  headingLevel = 3,
  align = "start",
  className,
}: ErrorStateProps) {
  const Heading = `h${headingLevel}` as const;
  const Mark = tone === "danger" ? IconCross : IconAlert;

  return (
    <div
      className={className === undefined ? "pv-error-state" : `pv-error-state ${className}`}
      data-tone={tone}
      data-align={align}
      // Polite, never assertive: an operator mid-sentence in a rejection reason
      // should not have the screen reader cut across them. The failure is not
      // going anywhere.
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
    >
      <p className="pv-error-state-eyebrow">
        <Mark size="sm" />
        {WORDS[tone]}
      </p>
      <Heading className="pv-error-state-title">{title}</Heading>
      {meaning === undefined && guidance === undefined ? null : (
        <div className="pv-error-state-body">
          {meaning === undefined ? null : <p>{meaning}</p>}
          {guidance === undefined ? null : <p>{guidance}</p>}
        </div>
      )}
      {actions === undefined ? null : <div className="pv-error-state-actions">{actions}</div>}
      <p className="pv-error-state-reference">
        Reference <code>{reference}</code>
      </p>
    </div>
  );
}
