import { useRef, useState, type ReactNode } from "react";
import { useClient } from "../api/ClientProvider";
import type { ApprovalView, DenialView, RiskTier } from "../api/contract";
import { isDenial } from "../api/client";
import { useResource } from "../api/useResource";
import { formatCountdown, formatDateTime } from "../format";
import { ResourceView } from "../ResourceView";
import { Link } from "../routing";
import type { StatusTone } from "../theme/tokens";
import { Badge, Button, Callout, Card, IconAlert, Modal, Panel, Textarea } from "../ui";
import { useNow } from "../useNow";
import { Denial } from "./Denial";

/**
 * The approval detail — the most consequential screen in the console.
 *
 * Its whole job is to show *exactly what is being authorised*, because an
 * approval is a person putting their name to a specific proposal and the audit
 * record will say they did. Everything here follows from that:
 *
 *   - The proposal is rendered field by field, in full. Nothing is summarised
 *     away, nothing is behind a disclosure the approver might not open.
 *
 *   - The proposal digest is displayed complete and untruncated. The approval
 *     binds to that digest (ADR 0005), so the artifact the approver read and
 *     the artifact their decision covers can be compared by eye. A digest
 *     shortened to eight characters would defeat the reason it is on screen.
 *     It is a plain `<span>` for that reason too: nothing may wrap it, split it
 *     across elements, or slip a decorative mark inside it.
 *
 *   - Irreversibility and risk tier are stated in words, near the top, before
 *     the decide controls rather than beside them.
 *
 *   - Where a step-up re-authentication will be demanded, that is said before
 *     the operator commits. Learning it afterwards, mid-flow, is how people
 *     end up clicking through a security prompt without reading it.
 *
 *   - Who has already decided, and what they said, is shown in full. N-of-M
 *     approval is worthless if the second approver cannot see that the first
 *     one hedged.
 */

const EXPIRING_SOON_MS = 15 * 60 * 1000;

type Decision = "granted" | "rejected";

interface RiskPresentation {
  readonly label: string;
  readonly tone: StatusTone;
  /** Set only where the tone's own mark would say the wrong thing. */
  readonly icon?: ReactNode;
}

/**
 * Risk tier, in words. The tone and the mark are redundant channels layered on
 * top of the label, never the carrier — the tier still reads in greyscale and
 * on the printed evidence export (WCAG 1.4.1).
 *
 * `prohibited` takes the `denied` tone rather than `danger`: a tier the
 * platform will not run is a control doing its job, not a fault.
 * `high_consequence` keeps the alert mark instead of accepting `danger`'s
 * cross, because the tier warns about what the action will do and does not
 * report that something has gone wrong.
 *
 * It lives in this file because the library has no home for the console's
 * status vocabulary yet. Five other views carry the same map and want the same
 * one; `src/ui/domain` is where it belongs.
 */
const RISK: Readonly<Record<RiskTier, RiskPresentation>> = {
  routine: { label: "Routine", tone: "neutral" },
  sensitive: { label: "Sensitive", tone: "info" },
  high_consequence: { label: "High consequence", tone: "danger", icon: <IconAlert size="sm" /> },
  prohibited: { label: "Prohibited", tone: "denied" },
};

function RiskBadge({ risk }: { readonly risk: RiskTier }) {
  const presentation = RISK[risk];
  // "Routine risk", not "Routine": the bare label sitting beside an action
  // description reads as a property of the action rather than of its tier.
  return (
    <Badge tone={presentation.tone} icon={presentation.icon}>
      {presentation.label} risk
    </Badge>
  );
}

interface DefinitionItem {
  readonly term: string;
  readonly description: ReactNode;
}

/**
 * A real `<dl>`: a screen reader announces "definition list, N items" and pairs
 * each term with its description, which a two-column grid of divs does not.
 * Each pair is wrapped in a `display: contents` div so the layout can take its
 * columns without severing that pairing.
 *
 * Local for the same reason as `RiskBadge` — most of the detail views want this
 * exact shape and `src/ui` has no definition list to give them.
 */
function DefinitionList({ items }: { readonly items: readonly DefinitionItem[] }) {
  return (
    <dl className="pv-dl">
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.description}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface ApprovalDetailProps {
  readonly approval: ApprovalView;
  readonly onDecide?: (decision: Decision, note: string) => void;
  readonly submitting?: boolean;
  /** A refusal of the decision itself, rendered as an outcome rather than an error. */
  readonly decisionDenial?: DenialView;
  readonly decisionError?: string;
}

export function ApprovalDetail({
  approval,
  onDecide,
  submitting = false,
  decisionDenial,
  decisionError,
}: ApprovalDetailProps) {
  const now = useNow(1000);
  // Which decision is being confirmed is held apart from whether the dialog is
  // open, because the modal unmounts only once its exit transition has
  // finished. A single nullable value would flip the title from "Confirm your
  // rejection" to "Confirm your approval" while the dialog is still fading.
  const [decision, setDecision] = useState<Decision>("granted");
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | undefined>(undefined);

  const countdown = formatCountdown(approval.expiresAt, now);
  const remaining = Math.max(approval.approvalsRequired - approval.approvalsGranted, 0);

  // Three independent reasons the decide controls should not act. Each one
  // gets its own sentence, because "you can't do this" without a reason is the
  // single most common way an interface wastes someone's afternoon.
  const blockingReason: string | null = countdown.expired
    ? "This approval expired at " +
      formatDateTime(approval.expiresAt) +
      ". The parked action will not run. Raise the request again to start a fresh window."
    : approval.viewerMayDecide
      ? null
      : (approval.viewerMayNotDecideReason ??
        "You are not eligible to decide this approval. Eligibility is set by role, and by the rule that nobody approves their own proposal.");

  // An unavailable control that does not say why is worse than no control.
  const decideControlDescribedBy =
    blockingReason !== null
      ? "approval-decide-blocked"
      : submitting
        ? "approval-decide-submitting"
        : undefined;

  const proposalItems: DefinitionItem[] = approval.proposal.map((entry) => ({
    term: entry.label,
    description: entry.value,
  }));

  function openDialog(next: Decision): void {
    setNote("");
    setNoteError(undefined);
    setDecision(next);
    setConfirming(true);
  }

  function confirm(): void {
    // A rejection without a reason leaves the requester nothing to act on, and
    // leaves the audit record without the one thing a reader will want.
    if (decision === "rejected" && note.trim() === "") {
      setNoteError("Say why you are rejecting this. The requester and the audit record both need it.");
      return;
    }
    onDecide?.(decision, note.trim());
    setConfirming(false);
  }

  return (
    <div className="pv-stack">
      <div className="pv-page-header">
        <p className="pv-meta">
          <Link to="/approvals">Approvals</Link>
        </p>
        <h1>{approval.actionDescription}</h1>
        <p className="pv-page-lede pv-mono">{approval.action}</p>
      </div>

      {/* ---------------------------------------------------------------
          What is being authorised
          --------------------------------------------------------------- */}
      <Panel title="What you are authorising">
        <div className="pv-stack">
          <div className="pv-row">
            <RiskBadge risk={approval.risk} />
            {approval.reversible ? (
              <Badge tone="neutral">Reversible</Badge>
            ) : (
              <Badge tone="warning">Irreversible</Badge>
            )}
            {approval.requiresStepUp && <Badge tone="info">Re-authentication required</Badge>}
          </div>

          <p>{approval.summary}</p>

          {!approval.reversible && (
            <Callout tone="warning" title="This action cannot be undone">
              <p>
                Once this runs there is no compensating action that returns the world to its
                previous state. Read the proposal below in full before deciding.
              </p>
            </Callout>
          )}

          {approval.requiresStepUp && (
            <Callout tone="info" title="You will be asked to re-authenticate">
              <p>
                Confirming this decision will require you to prove your identity again, not
                merely to hold a valid session. Have whatever you sign in with to hand before
                you start.
              </p>
            </Callout>
          )}
        </div>
      </Panel>

      {/* ---------------------------------------------------------------
          The proposal, field by field
          --------------------------------------------------------------- */}
      <Panel title="The proposal">
        {proposalItems.length === 0 ? (
          <p>
            This proposal carries no fields. That is unusual — check with whoever raised it
            before deciding.
          </p>
        ) : (
          <DefinitionList items={proposalItems} />
        )}

        <div className="pv-stack-tight pv-space-above-wide">
          <h3>Proposal digest</h3>
          <p className="pv-meta">
            Your decision binds to this digest and to no other proposal. If the proposal is
            altered after you decide, the digest stops matching and the action is refused rather
            than run.
          </p>
          <p>
            <span className="pv-digest">{approval.proposalDigest}</span>
          </p>
        </div>
      </Panel>

      {/* ---------------------------------------------------------------
          Who has to decide, and who already has
          --------------------------------------------------------------- */}
      <Panel title="Decision progress">
        <DefinitionList
          items={[
            {
              term: "Approvals",
              description: `${approval.approvalsGranted} of ${approval.approvalsRequired} granted${
                remaining > 0
                  ? ` — ${remaining} more ${remaining === 1 ? "is" : "are"} needed`
                  : " — the requirement is met"
              }`,
            },
            {
              term: "Eligible roles",
              description:
                approval.eligibleRoles.length === 0
                  ? "No human role may decide this."
                  : approval.eligibleRoles.join(", "),
            },
            {
              term: "Raised by",
              description: `${approval.requestedBy.displayName} (${approval.requestedBy.roles.join(", ")})`,
            },
            {
              term: "Raised at",
              description: (
                <time dateTime={approval.requestedAt}>{formatDateTime(approval.requestedAt)}</time>
              ),
            },
            {
              term: "Expires",
              description: (
                <span>
                  <time dateTime={approval.expiresAt}>{formatDateTime(approval.expiresAt)}</time>
                  {" — "}
                  {/* Deliberately not inside a live region: this text changes
                      every second, and a screen reader that announced every
                      tick would make the page unusable. The absolute time
                      beside it is the accessible statement of the deadline. */}
                  <strong>{countdown.text}</strong>
                </span>
              ),
            },
          ]}
        />

        {!countdown.expired && countdown.totalMs < EXPIRING_SOON_MS && (
          <div className="pv-space-above">
            <Callout tone="warning" title="This approval expires shortly" live="polite">
              <p>
                Less than fifteen minutes remain. If it expires, the parked action does not run
                and the request has to be raised again.
              </p>
            </Callout>
          </div>
        )}

        <h3 className="pv-space-above-wide">Decisions so far</h3>
        {approval.decisions.length === 0 ? (
          <p className="pv-meta">Nobody has decided yet.</p>
        ) : (
          <ul className="pv-steps">
            {approval.decisions.map((entry) => (
              <li key={`${entry.actor.actorId}-${entry.decidedAt}`}>
                {/* A card, not a panel: a second approver reading four prior
                    decisions should get four records, not four more region
                    landmarks between them and the decide controls. */}
                <Card title={entry.actor.displayName} titleLevel={4}>
                  <div className="pv-stack-tight">
                    <div className="pv-row">
                      {entry.decision === "granted" ? (
                        <Badge tone="success">Granted</Badge>
                      ) : (
                        <Badge tone="danger">Rejected</Badge>
                      )}
                      <time className="pv-meta" dateTime={entry.decidedAt}>
                        {formatDateTime(entry.decidedAt)}
                      </time>
                    </div>
                    {entry.note !== undefined && <p>{entry.note}</p>}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* ---------------------------------------------------------------
          Decide
          --------------------------------------------------------------- */}
      <Panel title="Your decision">
        {decisionDenial !== undefined && (
          <div className="pv-space-below">
            <Denial denial={decisionDenial} attempted="recording your decision" headingLevel={3} />
          </div>
        )}

        {decisionError !== undefined && (
          <div className="pv-space-below">
            <Callout tone="danger" title="Your decision was not recorded" live="polite">
              <p>{decisionError}</p>
              <p className="pv-meta">
                Nothing was changed. The decision was not applied, and submitting it again is
                safe: it carries the same idempotency key, so a decision that did reach the
                platform cannot be applied twice.
              </p>
            </Callout>
          </div>
        )}

        {blockingReason !== null && (
          // The id sits on the wrapper because the callout owns its own markup
          // and the buttons' aria-describedby has to point at something.
          // Naming the whole block also means the tone word the callout
          // contributes is announced with the reason rather than left in the
          // border colour, where a screen reader gets nothing from it.
          <div id="approval-decide-blocked">
            <Callout tone="info" title={blockingReason} />
          </div>
        )}

        {submitting && (
          <p id="approval-decide-submitting" className="pv-meta" role="status">
            Recording your decision. The controls are unavailable until the platform answers.
          </p>
        )}

        {/* Reject carries the same size and weight as Approve. Neither answer is
            styled as the easy path (spec §3.2). */}
        <div className="pv-row pv-space-above">
          <Button
            variant="primary"
            unavailable={blockingReason !== null || submitting}
            describedBy={decideControlDescribedBy}
            onClick={() => openDialog("granted")}
          >
            Approve this action
          </Button>
          <Button
            variant="danger"
            unavailable={blockingReason !== null || submitting}
            describedBy={decideControlDescribedBy}
            onClick={() => openDialog("rejected")}
          >
            Reject
          </Button>
        </div>

        <p className="pv-meta pv-space-above">
          Whether these controls are offered is a courtesy of this screen, not a security
          boundary. The platform re-checks eligibility, the proposal digest, and every other
          control at the chokepoint when the decision is submitted.
        </p>
      </Panel>

      <Modal
        open={confirming}
        title={decision === "rejected" ? "Confirm your rejection" : "Confirm your approval"}
        onClose={() => setConfirming(false)}
        // The actions below already carry the way out, and a third dismissal
        // control competing with them is one more thing to read on the screen
        // where reading matters most.
        hideCloseButton
        // A stray click on the scrim would discard a typed rejection reason,
        // which is the one thing in here the operator cannot get back.
        dismissOnOutsideClick={false}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant={decision === "rejected" ? "danger" : "primary"} onClick={confirm}>
              {decision === "rejected" ? "Record my rejection" : "Record my approval"}
            </Button>
          </>
        }
      >
        <p>
          {decision === "rejected"
            ? "You are rejecting this action. It will not run."
            : "You are approving this action, and your name goes on the record against it."}
        </p>
        <DefinitionList
          items={[
            { term: "Action", description: approval.actionDescription },
            {
              term: "Reversible",
              description: approval.reversible
                ? "Yes"
                : "No — once it runs there is no way back.",
            },
            {
              term: "Proposal digest",
              description: <span className="pv-digest">{approval.proposalDigest}</span>,
            },
          ]}
        />

        {approval.requiresStepUp && decision === "granted" && (
          <Callout tone="info" title="Re-authentication follows">
            <p>You will be asked to prove your identity again before this is recorded.</p>
          </Callout>
        )}

        <Textarea
          label={decision === "rejected" ? "Why are you rejecting this?" : "Note (optional)"}
          hint="Recorded with your decision and visible to everyone who reads this approval."
          error={noteError}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Modal>
    </div>
  );
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `console-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Route-level container: loads the approval and submits the decision. */
export function ApprovalDetailRoute({ approvalId }: { readonly approvalId: string }) {
  const client = useClient();
  const resource = useResource(
    (signal) => client.approval(approvalId, { signal }),
    [client, approvalId],
  );

  const [submitting, setSubmitting] = useState(false);
  const [decisionError, setDecisionError] = useState<string | undefined>(undefined);
  const [decisionDenial, setDecisionDenial] = useState<DenialView | undefined>(undefined);

  // One key per approval, generated once. A resubmission after a network
  // failure carries the same key, so a decision that did reach the platform is
  // recognised rather than applied twice. The client never retries on its own.
  const idempotencyKey = useRef<string>(newIdempotencyKey());

  async function decide(decision: Decision, note: string): Promise<void> {
    setSubmitting(true);
    setDecisionError(undefined);
    setDecisionDenial(undefined);
    try {
      const outcome = await client.decideApproval(approvalId, {
        decision,
        note,
        idempotencyKey: idempotencyKey.current,
      });
      if (isDenial(outcome)) setDecisionDenial(outcome);
      else resource.reload();
    } catch (cause) {
      setDecisionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ResourceView resource={resource} attempted="this approval">
      {(approval) => (
        <ApprovalDetail
          approval={approval}
          submitting={submitting}
          decisionError={decisionError}
          decisionDenial={decisionDenial}
          onDecide={(decision, note) => {
            void decide(decision, note);
          }}
        />
      )}
    </ResourceView>
  );
}
