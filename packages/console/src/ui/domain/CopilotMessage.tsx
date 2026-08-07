import type { ReactNode } from "react";
import { Button } from "../primitives/Button";
import { EvidenceItem } from "./EvidenceItem";
import type { ProvenanceKind } from "./ProvenanceMark";
import "./CopilotMessage.css";

/**
 * One turn in the copilot conversation.
 *
 * **An action card renders only when the message is complete.** This is the
 * rule spec §3.6 states and the one with teeth: a proposed action that
 * assembles itself while the text is still arriving is a button an operator can
 * click when it says "Send to 3 owners" and before it says "in Florida". Text
 * streams; anything with a consequence attached appears whole or not at all.
 *
 * **Citations are checkable in place.** They are the same `EvidenceItem` the
 * approval screen uses, with the same retrieved / asserted / computed
 * distinction and the same inline expansion — because an answer whose sources
 * cannot be checked without leaving the conversation is an answer nobody
 * checks. One vocabulary for provenance across the whole product is worth more
 * than a denser chat bubble.
 *
 * **Cost and elapsed are always on the message.** In `caption`, quietly, but
 * present: a copilot whose cost is invisible is a copilot nobody governs, and
 * this platform's argument is that everything it does is accountable.
 *
 * **"I don't know" is a designed answer.** It is not a failure state and it is
 * not styled as one — it is the honest response, and it comes with the offer to
 * route the question to a person who does know.
 */

export interface CopilotCitation {
  readonly id: string;
  /** The marker written inline in the body — "1" for a `[1]` in the text. */
  readonly marker?: string;
  readonly source: string;
  readonly kind: ProvenanceKind;
  readonly version?: string;
  readonly effectiveDate?: string;
  /** The exact words. Expanded in place. */
  readonly passage?: ReactNode;
  readonly href?: string;
}

export interface CopilotMessageProps {
  readonly author: "operator" | "copilot";
  /** Overrides the displayed name. Defaults to "You" and "Copilot". */
  readonly authorName?: string;
  /** When it was said, already formatted. */
  readonly time?: string;
  readonly body: ReactNode;
  /** Text is still arriving. Holds back the action card and marks the region busy. */
  readonly streaming?: boolean;
  readonly citations?: readonly CopilotCitation[];
  /**
   * A proposed action, with the approval anatomy. Rendered only once the
   * message is complete — never half-formed.
   */
  readonly action?: ReactNode;
  /** What this turn cost, already formatted. "$0.011". */
  readonly cost?: string;
  /** How long it took, already formatted. "1.4s". */
  readonly elapsed?: string;
  /** Marks this as the designed "I don't know" answer. */
  readonly unknown?: boolean;
  /** Offers to hand the question to a person. Pairs with `unknown`. */
  readonly onRouteToHuman?: () => void;
  readonly routeToHumanLabel?: string;
  /** Drops the controls and keeps the transcript. This is the auditor's view. */
  readonly readOnly?: boolean;
  readonly className?: string;
}

export function CopilotMessage({
  author,
  authorName,
  time,
  body,
  streaming = false,
  citations = [],
  action,
  cost,
  elapsed,
  unknown = false,
  onRouteToHuman,
  routeToHumanLabel = "Ask a person",
  readOnly = false,
  className,
}: CopilotMessageProps) {
  const name = authorName ?? (author === "operator" ? "You" : "Copilot");

  return (
    <article
      className={className === undefined ? "pv-copilot" : `pv-copilot ${className}`}
      data-author={author}
      data-unknown={unknown || undefined}
    >
      <p className="pv-copilot-byline">
        <span className="pv-copilot-author">{name}</span>
        {time === undefined ? null : (
          <time className="pv-copilot-time" data-numeric>
            {time}
          </time>
        )}
      </p>

      {/* No aria-live here on purpose. A live region on streaming text
          announces every partial sentence, which is unusable; the conversation
          owns one status message, and aria-busy is what says this turn is
          still arriving. */}
      <div className="pv-copilot-body" aria-busy={streaming || undefined}>
        {body}
        {streaming ? (
          <>
            <span className="pv-copilot-caret" aria-hidden="true" />
            <span className="pv-sr-only">Still answering.</span>
          </>
        ) : null}
      </div>

      {citations.length === 0 ? null : (
        <ul className="pv-copilot-citations">
          {citations.map((citation) => (
            <li key={citation.id}>
              <EvidenceItem
                source={
                  citation.marker === undefined
                    ? citation.source
                    : `[${citation.marker}] ${citation.source}`
                }
                version={citation.version}
                effectiveDate={citation.effectiveDate}
                kind={citation.kind}
                passage={citation.passage}
                href={citation.href}
                readOnly={readOnly}
              />
            </li>
          ))}
        </ul>
      )}

      {/* The gate. Half a proposed action is worse than none. */}
      {action !== undefined && !streaming ? (
        <div className="pv-copilot-action">{action}</div>
      ) : null}

      {onRouteToHuman === undefined || readOnly || streaming ? null : (
        <div className="pv-copilot-route">
          <Button size="sm" variant="secondary" onClick={onRouteToHuman}>
            {routeToHumanLabel}
          </Button>
        </div>
      )}

      {cost === undefined && elapsed === undefined ? null : (
        <p className="pv-copilot-footer">
          {cost === undefined ? null : (
            <span data-numeric>
              <span className="pv-sr-only">Cost </span>
              {cost}
            </span>
          )}
          {cost !== undefined && elapsed !== undefined ? (
            <span aria-hidden="true">·</span>
          ) : null}
          {elapsed === undefined ? null : (
            <span data-numeric>
              <span className="pv-sr-only">Took </span>
              {elapsed}
            </span>
          )}
        </p>
      )}
    </article>
  );
}
