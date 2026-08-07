import type { ReactNode } from "react";
import "./EmptyState.css";

/**
 * Nothing here, and why that is.
 *
 * An empty result is a state, not a blank area. The two situations an operator
 * can be in are completely different — "no work has arrived" and "your filters
 * excluded all of it" — and the difference between them is the difference
 * between closing the laptop and clearing a filter. So this component asks for
 * the sentence that says which one it is, and refuses to render without it.
 *
 * It is illustration-free by decision (spec §3.1). A cartoon in an operator
 * console is a thing to look past on the way to the answer, and by the fortieth
 * time an approver has cleared their queue it is an insult. What earns its
 * place is the copy and the way out.
 *
 * The copy rules are spec §6 and they are the caller's to keep: say what would
 * have been here, say when it will arrive, and offer the control that changes
 * the situation. Never "Nothing to see here", never an exclamation mark.
 */

export interface EmptyStateProps {
  /** The state, as a sentence. "Nothing needs you right now." */
  readonly title: string;
  /** Why it is empty and what will change it. Required — a bare title is a shrug. */
  readonly body: ReactNode;
  /**
   * The way out. Usually two controls: the one that changes what arrives here,
   * and the one that widens what is being shown.
   */
  readonly actions?: ReactNode;
  /**
   * A caption under the actions. Where the filter count goes — "3 filters are
   * active" is the sentence that turns a confusing empty table into an obvious
   * one.
   */
  readonly hint?: ReactNode;
  /** Document structure, not size. Match the surrounding outline. */
  readonly headingLevel?: 2 | 3 | 4;
  /** Centres the block in a large region. Left-aligned inside a card or a panel. */
  readonly align?: "start" | "center";
  readonly className?: string;
}

export function EmptyState({
  title,
  body,
  actions,
  hint,
  headingLevel = 3,
  align = "center",
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      className={className === undefined ? "pv-empty-state" : `pv-empty-state ${className}`}
      data-align={align}
    >
      <Heading className="pv-empty-state-title">{title}</Heading>
      {/* Body copy is never centred, whatever the block's alignment: a centred
          paragraph makes the eye hunt for a new left edge on every line. */}
      <div className="pv-empty-state-body">{body}</div>
      {actions === undefined ? null : <div className="pv-empty-state-actions">{actions}</div>}
      {hint === undefined ? null : <p className="pv-empty-state-hint">{hint}</p>}
    </div>
  );
}
