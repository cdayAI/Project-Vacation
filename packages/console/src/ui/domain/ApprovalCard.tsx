import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Badge } from "../primitives/Badge";
import { Button } from "../primitives/Button";
import { Chip } from "../primitives/Chip";
import { IconChevronDown } from "../primitives/icons";
import { Radio, RadioGroup } from "../primitives/Radio";
import { Textarea } from "../primitives/Textarea";
import { ReadOnlyChip } from "../surfaces/ReadOnlyChip";
import { SurfaceState } from "../surfaces/SurfaceState";
import { Callout } from "./Callout";
import type { RiskTier } from "../../api/contract";
import "./ApprovalCard.css";

/**
 * The approval. This is the anatomy the whole product is judged on.
 *
 * Spec §3.2 fixes the order of the left column and this component fixes it in
 * the type system, because the order is the argument: what is being asked, who
 * asked, what happens if you say yes, what happens if you say no, why it needed
 * a human at all, who it touches, and what the claim rests on. An approver six
 * items into a queue of forty is not reading — they are pattern-matching
 * against the last five, and a screen that moves the blast radius somewhere
 * else on item seven costs them the second they were saving.
 *
 * -----------------------------------------------------------------------------
 * NEITHER BUTTON IS THE EASY PATH
 *
 * Approve and Reject are the same size, the same height, and the same width,
 * side by side in a two-column grid — not a primary button with a text link
 * beside it, and not a danger-red Reject. Both of those are the same design
 * defect pointing in opposite directions: they tell the operator which answer
 * the system wants, and an approval queue that nudges is an approval queue
 * whose record is worth nothing. Approve carries the accent because it is the
 * affirmative action; Reject carries a strong border on the surface. Equal
 * weight, different identity.
 *
 * Reject is not one click, either. It expands an inline reason selector —
 * inline, never a modal, because a modal covers the very evidence somebody is
 * rejecting on the basis of. The reason is captured as improvement signal
 * (spec §3.2), which is the only reason it is worth asking for.
 *
 * -----------------------------------------------------------------------------
 * WHAT WILL HAPPEN IS THE ARTIFACT, NOT A PARAPHRASE
 *
 * "If you approve" takes the concrete effects as bullets and, separately, the
 * *exact artifact* — the letter that will be sent, the record that will be
 * written — behind an inline preview. A summary of an outbound letter is not
 * the letter, and the difference between them is where a compliance failure
 * hides.
 */

export type ApprovalRequestKind = "workflow" | "external-agent" | "system-change";

/**
 * The platform's tiers, not a second vocabulary.
 *
 * An earlier draft of this component took low / medium / high, which reads
 * naturally and is wrong: the platform classifies every action as routine,
 * sensitive, high_consequence or prohibited, and those words appear in the
 * action registry, the audit chain, and the approval record. A component with
 * its own scale forces every screen to translate, and a translation table is
 * where "sensitive" quietly becomes "medium" in one place and "low" in
 * another. The approver and the audit record must be reading the same word.
 */
export type ApprovalRisk = RiskTier;

/** Distinct colours and distinct words — spec §3.2 item 2. */
const KIND_LABELS: Readonly<Record<ApprovalRequestKind, string>> = {
  workflow: "Workflow",
  "external-agent": "External agent",
  "system-change": "System change",
};

const KIND_TONES = {
  workflow: "info",
  "external-agent": "denied",
  "system-change": "warning",
} as const;

const RISK_LABELS: Readonly<Record<ApprovalRisk, string>> = {
  routine: "Routine",
  sensitive: "Sensitive",
  high_consequence: "High consequence",
  prohibited: "Prohibited",
};

/**
 * `prohibited` carries the danger tone and is expected never to appear here.
 * A prohibited action is refused by the chokepoint and never reaches a queue,
 * so rendering one at all would mean something upstream is broken — which is
 * exactly why it must not render as an unstyled fallback.
 */
const RISK_TONES = {
  routine: "neutral",
  sensitive: "warning",
  high_consequence: "danger",
  prohibited: "danger",
} as const;

export interface ApprovalBlastRadius {
  /** How many owners this touches. "3 owners in Florida". */
  readonly ownersAffected: ReactNode;
  /** The money at stake. "$0 — no payment moves". */
  readonly money: ReactNode;
  /** Whether it can be undone, in a word plus the condition. "Yes, within 24 hours". */
  readonly reversible: ReactNode;
  /** How, concretely. "Void the notice and re-issue from the case". */
  readonly howToReverse: ReactNode;
}

export interface ApprovalRejectReason {
  readonly id: string;
  readonly label: string;
  /** What choosing this one means downstream. */
  readonly description?: string;
}

export interface ApprovalDecision {
  readonly outcome: "approved" | "rejected";
  readonly by: string;
  readonly at: string;
  readonly reason?: string;
}

export interface ApprovalCardProps {
  /** The ask, in plain language. "Send a rescission confirmation to 3 owners in Florida." */
  readonly ask: string;
  readonly headingLevel?: 2 | 3 | 4;

  /** Who or what asked. */
  readonly requestedBy: string;
  readonly requestKind: ApprovalRequestKind;
  /** When, already formatted. "Requested 09:41". */
  readonly requestedAt: string;
  readonly risk: ApprovalRisk;

  /** The concrete effects. Up to four; a fifth means the ask is two asks. */
  readonly ifApproved: readonly ReactNode[];
  /** The exact artifact, behind an inline preview. Never a paraphrase. */
  readonly artifact?: { readonly label: string; readonly preview: ReactNode };
  /** One line, same weight, no callout. */
  readonly ifRejected: ReactNode;
  /** The rule and its threshold. "State rescission notice · high risk · policy R-14". */
  readonly rule?: { readonly label: string; readonly href?: string };

  readonly blastRadius: ApprovalBlastRadius;
  /** `EvidenceItem`s. Expandable in place — an approver never navigates to check. */
  readonly evidence?: ReactNode;
  /** The last five comparable decisions. This is how an approver calibrates. */
  readonly priorDecisions?: ReactNode;

  readonly onApprove?: () => void;
  readonly onReject?: (rejection: { readonly reasonId?: string; readonly note: string }) => void;
  /** Offered in the inline reason selector. Captured as improvement signal. */
  readonly rejectReasons?: readonly ApprovalRejectReason[];
  readonly approveLabel?: string;
  readonly rejectLabel?: string;
  /** Keeps both buttons in place and spins the one that was pressed. */
  readonly busy?: "approve" | "reject";

  /** Already decided. Replaces the actions with the record of what happened. */
  readonly decision?: ApprovalDecision;
  /** No actions at all — the auditor's view of a live approval. */
  readonly readOnly?: boolean;

  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly className?: string;
}

export function ApprovalCard({
  ask,
  headingLevel = 2,
  requestedBy,
  requestKind,
  requestedAt,
  risk,
  ifApproved,
  artifact,
  ifRejected,
  rule,
  blastRadius,
  evidence,
  priorDecisions,
  onApprove,
  onReject,
  rejectReasons = [],
  approveLabel = "Approve",
  rejectLabel = "Reject",
  busy,
  decision,
  readOnly = false,
  loading = false,
  error,
  className,
}: ApprovalCardProps) {
  const baseId = useId();
  const askId = `${baseId}-ask`;
  const artifactId = `${baseId}-artifact`;
  const Heading = `h${headingLevel}` as const;

  const [previewOpen, setPreviewOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const reasonRef = useRef<HTMLDivElement>(null);

  // Focus lands on the first reason the moment the selector opens. The operator
  // asked for this panel by pressing Reject, so moving focus is expected rather
  // than a hijack — and without it a keyboard operator has to tab back through
  // the whole decision bar to reach the control that just appeared.
  useEffect(() => {
    if (!rejecting) return;
    const first = reasonRef.current?.querySelector<HTMLElement>(
      'input[type="radio"], textarea, button',
    );
    first?.focus();
  }, [rejecting]);

  const decided = decision !== undefined;
  const showActions = !readOnly && !decided && (onApprove !== undefined || onReject !== undefined);

  return (
    <section
      className={className === undefined ? "pv-approval" : `pv-approval ${className}`}
      aria-labelledby={askId}
      data-read-only={readOnly || undefined}
      data-decided={decided || undefined}
    >
      <SurfaceState loading={loading} error={error} skeletonLines={6}>
        <header className="pv-approval-header">
          <Heading className="pv-approval-ask" id={askId}>
            {ask}
          </Heading>

          {/* Who asked, what kind of thing it is, when, and how risky. Four
              facts an approver reads before the ask itself on item seven. */}
          <div className="pv-approval-provenance">
            <Chip size="sm">{requestedBy}</Chip>
            <Badge tone={KIND_TONES[requestKind]} size="sm">
              {KIND_LABELS[requestKind]}
            </Badge>
            <span className="pv-approval-requested" data-numeric>
              {requestedAt}
            </span>
            <Badge tone={RISK_TONES[risk]} size="sm">
              {RISK_LABELS[risk]}
            </Badge>
            {readOnly ? <ReadOnlyChip /> : null}
          </div>
        </header>

        <Callout title="If you approve" tone="info" emphasis="outline">
          <ul>
            {ifApproved.map((effect, index) => (
              // Effects are prose supplied by the caller and have no stable id
              // of their own; the list is re-rendered wholesale when the
              // approval changes, so the index is the honest key here.
              <li key={index}>{effect}</li>
            ))}
          </ul>

          {artifact === undefined ? null : (
            <div className="pv-approval-artifact">
              <Button
                size="sm"
                variant="secondary"
                aria-expanded={previewOpen}
                aria-controls={artifactId}
                onClick={() => setPreviewOpen((open) => !open)}
              >
                <IconChevronDown
                  size="sm"
                  className={previewOpen ? "pv-approval-chevron-open" : undefined}
                />
                {previewOpen ? "Hide" : "Preview"} {artifact.label}
              </Button>
              <div className="pv-approval-artifact-preview" id={artifactId} hidden={!previewOpen}>
                {artifact.preview}
              </div>
            </div>
          )}
        </Callout>

        {/* Same weight as the approval consequence, deliberately without the
            border: giving rejection its own callout would make it look like the
            heavier of the two decisions. */}
        <p className="pv-approval-rejected">
          <span className="pv-approval-rejected-label">If you reject</span>
          <span className="pv-approval-rejected-text">{ifRejected}</span>
        </p>

        {rule === undefined ? null : (
          <p className="pv-approval-rule">
            <span className="pv-approval-rule-label">Why this needs you</span>
            {rule.href === undefined ? (
              <span className="pv-approval-rule-value">{rule.label}</span>
            ) : (
              <a className="pv-approval-rule-value" href={rule.href}>
                {rule.label}
              </a>
            )}
          </p>
        )}

        {/* Four cells, caption labels over body-strong values (spec §3.2 item
            6). A definition list because that is what it is: four terms and
            their values, which is also how a screen reader will read it. */}
        <dl className="pv-approval-blast">
          <div className="pv-approval-blast-cell">
            <dt>Owners affected</dt>
            <dd data-numeric>{blastRadius.ownersAffected}</dd>
          </div>
          <div className="pv-approval-blast-cell">
            <dt>Money</dt>
            <dd data-numeric>{blastRadius.money}</dd>
          </div>
          <div className="pv-approval-blast-cell">
            <dt>Reversible?</dt>
            <dd>{blastRadius.reversible}</dd>
          </div>
          <div className="pv-approval-blast-cell">
            <dt>How to reverse</dt>
            <dd>{blastRadius.howToReverse}</dd>
          </div>
        </dl>

        {evidence === undefined ? null : (
          <div className="pv-approval-section">
            <h3 className="pv-approval-section-title">Evidence</h3>
            {evidence}
          </div>
        )}

        {priorDecisions === undefined ? null : (
          <div className="pv-approval-section">
            <h3 className="pv-approval-section-title">Prior similar decisions</h3>
            {priorDecisions}
          </div>
        )}

        {decided && decision !== undefined ? (
          <p className="pv-approval-decision" data-outcome={decision.outcome}>
            <Badge tone={decision.outcome === "approved" ? "success" : "denied"} size="sm">
              {decision.outcome === "approved" ? "Approved" : "Rejected"}
            </Badge>
            <span>
              by {decision.by} · {decision.at}
              {decision.reason === undefined ? null : ` · ${decision.reason}`}
            </span>
          </p>
        ) : null}

        {showActions ? (
          <div className="pv-approval-decision-bar">
            {rejecting ? (
              <div className="pv-approval-reason" ref={reasonRef}>
                {rejectReasons.length === 0 ? null : (
                  <RadioGroup
                    label="Why are you rejecting this?"
                    value={reason}
                    onChange={setReason}
                  >
                    {rejectReasons.map((option) => (
                      <Radio
                        key={option.id}
                        value={option.id}
                        label={option.label}
                        description={option.description}
                      />
                    ))}
                  </RadioGroup>
                )}
                <Textarea
                  label="Anything else the team should know"
                  hint="This goes to the people who tune the workflow."
                  rows={3}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <div className="pv-approval-reason-actions">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRejecting(false);
                      setReason(null);
                    }}
                  >
                    Keep reviewing
                  </Button>
                  <Button
                    variant="primary"
                    loading={busy === "reject"}
                    onClick={() =>
                      onReject?.({ reasonId: reason ?? undefined, note })
                    }
                  >
                    Confirm rejection
                  </Button>
                </div>
              </div>
            ) : (
              <div className="pv-approval-actions">
                {/* Two equal columns. The grid is what makes "equal visual
                    weight" a property of the layout rather than a promise in a
                    comment — neither button can grow past the other. */}
                <Button
                  variant="secondary"
                  size="lg"
                  fullWidth
                  loading={busy === "reject"}
                  onClick={() => setRejecting(true)}
                >
                  {rejectLabel}
                </Button>
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  loading={busy === "approve"}
                  onClick={onApprove}
                >
                  {approveLabel}
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </SurfaceState>
    </section>
  );
}
