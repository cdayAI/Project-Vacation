import type { ReactNode } from "react";

export interface EmptyStateProps {
  readonly title: string;
  readonly body: string;
  /** A control that gets the operator somewhere useful. */
  readonly action?: ReactNode;
  /** Matches the surrounding document outline. Defaults to h3. */
  readonly headingLevel?: 2 | 3 | 4;
}

/**
 * An empty result is a state, not a blank area.
 *
 * It says what would have been here and why it is not, because "no rows" and
 * "the filter excluded everything" are different situations and an operator
 * staring at an empty queue needs to know which one they are in.
 */
export function EmptyState({ title, body, action, headingLevel = 3 }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <div className="pv-empty">
      <Heading>{title}</Heading>
      <p className="pv-empty-body">{body}</p>
      {action}
    </div>
  );
}
