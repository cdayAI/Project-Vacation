import { useId, useState, type ReactNode } from "react";
import { IconChevronDown } from "../primitives/icons";
import { MarkExternal } from "./marks";
import { ProvenanceMark, type ProvenanceKind } from "./ProvenanceMark";
import "./EvidenceItem.css";

/**
 * One piece of evidence: where a claim came from, and the words it came from.
 *
 * **The passage opens here. It never navigates away.** Spec §3.2 item 7 is
 * blunt about this and the reason is behavioural: an approver who has to leave
 * the screen to check a citation stops checking citations. Not immediately —
 * around item six of forty, when the queue is long and every previous citation
 * has checked out. So the exact text expands inline, under the source, and the
 * operator's place in the queue is never at risk. A link to the source is
 * offered as well, marked as leaving, for the rarer case where somebody needs
 * the whole document.
 *
 * **Source, version, and effective date travel together.** A statute without a
 * revision and an effective date is not evidence in a regulated process — the
 * question is never "what does the rule say", it is "what did the rule say on
 * the day we acted". They render as one line so they cannot be separated by a
 * later layout change.
 *
 * **Provenance is visible before expansion.** Retrieved, asserted, or computed
 * changes what an approver should do with the item, so it cannot be behind the
 * disclosure that the item's own text is behind.
 */

export interface EvidenceItemProps {
  /** Where it came from. "Florida Statutes §721.10". */
  readonly source: string;
  /** The version or revision. "rev 2025-07-01". */
  readonly version?: string;
  /** The date the version took effect. "Effective 1 Jul 2025". */
  readonly effectiveDate?: string;
  readonly kind: ProvenanceKind;
  /** One line about what this evidence supports. */
  readonly summary?: ReactNode;
  /** The exact words. Expanded inline — never behind a navigation. */
  readonly passage?: ReactNode;
  /** The whole document, for the rare case that needs it. Marked as leaving. */
  readonly href?: string;
  readonly hrefLabel?: string;
  /** Open on first render, for the single item an approval turns on. */
  readonly defaultExpanded?: boolean;
  /** Controlled expansion, for a screen with an "expand all" control. */
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** Trailing controls — "Use this", "Flag as wrong". Dropped when read-only. */
  readonly actions?: ReactNode;
  readonly readOnly?: boolean;
  readonly className?: string;
}

export function EvidenceItem({
  source,
  version,
  effectiveDate,
  kind,
  summary,
  passage,
  href,
  hrefLabel = "Open the source",
  defaultExpanded = false,
  expanded,
  onExpandedChange,
  actions,
  readOnly = false,
  className,
}: EvidenceItemProps) {
  const passageId = useId();
  const [uncontrolled, setUncontrolled] = useState(defaultExpanded);
  const isControlled = expanded !== undefined;
  const open = isControlled ? expanded : uncontrolled;
  const hasPassage = passage !== undefined && passage !== null;

  function toggle(): void {
    const next = !open;
    if (!isControlled) setUncontrolled(next);
    onExpandedChange?.(next);
  }

  return (
    <article
      className={className === undefined ? "pv-evidence" : `pv-evidence ${className}`}
      data-expanded={open || undefined}
      data-read-only={readOnly || undefined}
    >
      <div className="pv-evidence-header">
        <div className="pv-evidence-identity">
          {hasPassage ? (
            <button
              type="button"
              className="pv-evidence-toggle"
              aria-expanded={open}
              aria-controls={passageId}
              onClick={toggle}
            >
              <IconChevronDown
                size="sm"
                className={open ? "pv-evidence-chevron-open" : undefined}
              />
              <span className="pv-evidence-source">{source}</span>
              {/* The button's name has to be unique in a list of eight
                  citations, and "Show passage" eight times is not a list a
                  screen-reader user can navigate. */}
              <span className="pv-sr-only">{open ? " — hide the passage" : " — show the passage"}</span>
            </button>
          ) : (
            <span className="pv-evidence-source">{source}</span>
          )}

          <p className="pv-evidence-provenance">
            <ProvenanceMark kind={kind} />
          </p>
        </div>

        {actions === undefined || readOnly ? null : (
          <div className="pv-evidence-actions">{actions}</div>
        )}
      </div>

      {version === undefined && effectiveDate === undefined ? null : (
        <p className="pv-evidence-version">
          {version === undefined ? null : <span data-numeric>{version}</span>}
          {version !== undefined && effectiveDate !== undefined ? (
            <span aria-hidden="true"> · </span>
          ) : null}
          {effectiveDate === undefined ? null : <span data-numeric>{effectiveDate}</span>}
        </p>
      )}

      {summary === undefined ? null : <p className="pv-evidence-summary">{summary}</p>}

      {hasPassage ? (
        <div className="pv-evidence-passage" id={passageId} hidden={!open}>
          {/* A blockquote because it is a quotation: the semantics are what tell
              a screen-reader user that these are somebody else's words and not
              the platform's summary of them. */}
          <blockquote className="pv-evidence-quote" cite={href}>
            {passage}
          </blockquote>
          {href === undefined ? null : (
            <a className="pv-evidence-link" href={href}>
              {hrefLabel}
              <MarkExternal size="sm" />
              {/* Says it leaves. An approver mid-queue deserves the warning. */}
              <span className="pv-sr-only"> (opens the full document)</span>
            </a>
          )}
        </div>
      ) : null}
    </article>
  );
}
