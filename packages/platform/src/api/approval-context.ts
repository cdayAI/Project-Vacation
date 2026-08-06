import { digestValue, digestsEqual } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ApprovalRequest } from "../guard/types.js";
import type { ActionDescriptor, RiskTier } from "../guard/types.js";
import type { Platform } from "../platform.js";
import type { ActorRef, Run } from "../record/types.js";

/**
 * Everything an approver needs to decide, in one payload.
 *
 * The screen this serves has one requirement: **open to decided, with real
 * understanding, in under ten seconds.** Every field here exists because a
 * person cannot reach that bar without it, and the rules that shape the file
 * follow from that.
 *
 * **Nothing is composed from prose.** The provenance kind is read from the
 * record — `subject.principal`, the requester's kind, the action's own
 * `changesPlatformBehaviour` flag — and never from the shape of the summary
 * string. A classification derived by matching text is a classification that
 * changes when somebody rewords a sentence.
 *
 * **Absence is a value.** Owners affected, money, evidence, and the artifact
 * preview are all things this deployment may genuinely not know, because they
 * live in systems of record nobody has connected. Each one is optional and
 * carries a sentence saying why it is missing. A fabricated blast radius is
 * worse than an absent one: an approver who discovers the number is decorative
 * stops reading it, and then stops reading the ones beside it.
 *
 * **What is shown is what was approved.** The artifact preview is only offered
 * when its content re-digests to the approval's `proposalDigest`. A preview
 * that merely *represents* the proposal would let an approver read one thing
 * and authorise another, which is precisely the attack digest binding exists
 * to close.
 */

export type ProvenanceKind = "workflow" | "external_agent" | "system_change";

export interface ApprovalProvenance {
  readonly kind: ProvenanceKind;
  /** Who or what asked, as the badge reads it. */
  readonly label: string;
  readonly actor: { readonly actorId: string; readonly displayName: string; readonly roles: readonly string[] };
  /** Where an external agent runs, or the workflow a run belongs to. */
  readonly origin?: string | undefined;
  /** The person accountable for an external agent. Never a shared mailbox. */
  readonly accountable?: string | undefined;
  readonly runId?: string | undefined;
  /** Why the platform classified it this way. Shown on hover, never guessed. */
  readonly basis: string;
}

export type ApprovalArtifactKind =
  | "letter"
  | "message"
  | "document"
  | "record_write"
  | "configuration";

export interface ApprovalArtifact {
  readonly kind: ApprovalArtifactKind;
  readonly title: string;
  readonly mediaType: string;
  /** The exact content, for inline preview. Never a paraphrase. */
  readonly body: string;
  readonly digest: string;
  /**
   * True when re-digesting `body` reproduces the approval's proposal digest.
   *
   * False means the platform holds something that describes the proposal but
   * cannot prove it *is* the proposal, and the console must say so rather than
   * letting a preview stand in for the thing being authorised.
   */
  readonly matchesProposalDigest: boolean;
}

export interface ApprovalRule {
  /** Stable identity the console links to. The action name is the rule. */
  readonly ruleId: string;
  readonly name: string;
  /** The threshold in one line: tier, approvers, step-up. */
  readonly threshold: string;
  readonly risk: RiskTier;
  readonly humanInvolvement: string;
  readonly approvalsRequired: number;
  readonly requiresStepUp: boolean;
  /** Where the rule is declared, so the console links to the right place. */
  readonly source: "action_registry" | "external_admission";
  /**
   * False when the action is not in the registry.
   *
   * External agents raise approvals under `external.<operation>`, which is a
   * tool name from another company's product and deliberately not a registered
   * platform action. The screen must say the threshold came from the admission
   * chain rather than implying a registry entry that does not exist.
   */
  readonly registered: boolean;
}

export interface ApprovalBlastRadius {
  readonly ownersAffected?: number | undefined;
  readonly ownersAffectedUnknown?: string | undefined;
  readonly moneyUsd?: number | undefined;
  readonly moneyUnknown?: string | undefined;
  /**
   * How the effect is undone, or what makes it permanent.
   *
   * Whether it *can* be undone is `reversible` on the approval itself,
   * declared once on the action. Repeating the flag here would be two places
   * to change one fact, and they would eventually disagree.
   */
  readonly reversal: string;
  readonly jurisdictions: readonly string[];
}

export interface EvidenceItem {
  readonly citationId: string;
  readonly source: string;
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | undefined;
  readonly jurisdiction?: string | undefined;
  /** The exact passage, so a citation is checked without navigating away. */
  readonly passage: string;
  readonly sourceUri?: string | undefined;
  readonly stale: boolean;
}

export type PriorOutcome =
  | "completed"
  | "failed"
  | "refused"
  | "not_carried_out"
  | "awaiting_execution"
  | "unknown";

export interface PriorDecision {
  readonly approvalId: string;
  readonly ask: string;
  readonly decidedBy: { readonly actorId: string; readonly displayName: string; readonly roles: readonly string[] };
  readonly decision: "granted" | "rejected";
  readonly decidedAt: string;
  readonly outcome: PriorOutcome;
  readonly outcomeDetail: string;
  readonly runId?: string | undefined;
}

export interface ApprovalQueueRow {
  readonly approvalId: string;
  readonly action: string;
  readonly actionDescription: string;
  /** The ask in plain language. Never a serialised payload. */
  readonly ask: string;
  readonly risk: RiskTier;
  readonly reversible: boolean;
  readonly summary: string;
  readonly proposalDigest: string;
  readonly provenance: ApprovalProvenance;
  readonly effects: readonly string[];
  readonly ifRejected: string;
  readonly rule: ApprovalRule;
  readonly blastRadius: ApprovalBlastRadius;
  readonly requestedBy: { readonly actorId: string; readonly displayName: string; readonly roles: readonly string[] };
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly approvalsRequired: number;
  readonly approvalsGranted: number;
  readonly eligibleRoles: readonly string[];
  readonly viewerMayDecide: boolean;
  readonly viewerMayNotDecideReason?: string | undefined;
  readonly requiresStepUp: boolean;
  readonly runId?: string | undefined;
  /**
   * The proposal, field by field, and the decisions already recorded.
   *
   * On the queue row rather than the detail because neither costs a read: both
   * are on the approval this function was handed. The three fields that *do*
   * cost a read each — the artifact, the evidence, the lookback — are on
   * `ApprovalDetail`.
   */
  readonly proposal: readonly { readonly label: string; readonly value: string }[];
  readonly decisions: readonly {
    readonly actor: { readonly actorId: string; readonly displayName: string; readonly roles: readonly string[] };
    readonly decision: "granted" | "rejected";
    readonly decidedAt: string;
    readonly note?: string | undefined;
  }[];
}

export interface ApprovalDetail extends ApprovalQueueRow {
  readonly artifact?: ApprovalArtifact | undefined;
  readonly artifactUnknown?: string | undefined;
  readonly evidence: readonly EvidenceItem[];
  readonly evidenceUnknown?: string | undefined;
  readonly priorDecisions: readonly PriorDecision[];
}

/**
 * Where the two facts the operating record cannot hold come from.
 *
 * The record stores a *digest* of a proposal, not its content — deliberately,
 * so that seven years of approval history is not a second copy of owner
 * correspondence. And it stores no link from an approval to the passages the
 * proposal rests on. Both are real gaps, and both are filled by a deployment
 * wiring its document store and its corpus here rather than by this file
 * inventing something plausible.
 *
 * Unwired, the screen says what is missing and why. That is the honest state,
 * and it is a state the console is built to render.
 */
export interface DecisionContextSources {
  artifact?(approval: ApprovalRequest): Promise<ApprovalArtifact | null>;
  evidence?(approval: ApprovalRequest): Promise<readonly EvidenceItem[]>;
}

/** How many prior decisions on the same action an approver is shown. */
export const PRIOR_DECISION_COUNT = 5;

/** The pool searched for those five. Bounded so the detail read stays cheap. */
const PRIOR_DECISION_POOL = 60;

export function approvalQueueRow(
  approval: ApprovalRequest,
  viewer: ActorRef,
  platform: Platform,
): ApprovalQueueRow {
  const descriptor = platform.registry.get(approval.action);
  const granted = approval.decisions.filter((entry) => entry.decision === "granted").length;
  const provenance = provenanceOf(approval, descriptor);
  const risk = riskOf(approval, descriptor);

  return {
    approvalId: approval.id,
    action: approval.action,
    actionDescription: descriptor?.description ?? describeUnregistered(approval),
    ask: askOf(approval, descriptor, provenance),
    risk,
    reversible: descriptor?.reversible ?? false,
    summary: approval.summary,
    proposalDigest: approval.proposalDigest,
    provenance,
    effects: effectsOf(approval, descriptor, provenance),
    ifRejected: ifRejectedOf(approval, descriptor),
    rule: ruleOf(approval, descriptor, risk),
    blastRadius: blastRadiusOf(approval, descriptor),
    requestedBy: actorSummary(approval.requestedBy),
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    approvalsRequired: approval.approvalsRequired,
    approvalsGranted: granted,
    eligibleRoles: approval.eligibleRoles,
    ...viewerEligibility(approval, viewer),
    requiresStepUp: descriptor?.requiresStepUp ?? true,
    runId: approval.runId,
    proposal: Object.entries(approval.subject).map(([label, value]) => ({ label, value })),
    decisions: approval.decisions.map((entry) => ({
      actor: actorSummary(entry.actor),
      decision: entry.decision,
      decidedAt: entry.decidedAt,
      note: entry.note,
    })),
  };
}

export async function approvalDetail(
  approval: ApprovalRequest,
  viewer: ActorRef,
  platform: Platform,
  sources: DecisionContextSources = {},
): Promise<ApprovalDetail> {
  const row = approvalQueueRow(approval, viewer, platform);
  const artifact = await resolveArtifact(approval, sources);
  const evidence = sources.evidence ? await sources.evidence(approval) : [];

  return {
    ...row,
    artifact: artifact ?? undefined,
    artifactUnknown: artifact
      ? undefined
      : "This deployment holds a digest of the proposal, not its content, so there is nothing to preview inline. The digest below is what the decision binds to.",
    evidence,
    evidenceUnknown:
      sources.evidence === undefined
        ? "No corpus is connected to this deployment's approval path, so the passages behind this proposal cannot be shown here."
        : evidence.length === 0
          ? "This proposal cites no passages. That is worth asking about before approving anything that turns on an authority."
          : undefined,
    priorDecisions: await priorDecisions(approval, platform),
  };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Which of the three trust situations this is.
 *
 * Read from the record in a fixed order, most specific first. The
 * external-agent marker is the same `principal: "external"` the admission
 * chain writes onto runs, approvals, and audit entries alike, so one filter
 * finds every trace of external work — see external/admission.ts.
 */
export function provenanceOf(
  approval: ApprovalRequest,
  descriptor: ActionDescriptor | undefined,
): ApprovalProvenance {
  const subject = approval.subject;

  if (subject.principal === "external") {
    const agentName = subject.agentName ?? approval.requestedBy.actorId;
    return {
      kind: "external_agent",
      label: agentName,
      actor: actorSummary(approval.requestedBy),
      origin: subject.hostPlatform,
      accountable: subject.owner,
      runId: approval.runId,
      basis:
        "The approval's subject carries the external-agent marker written by the admission chain.",
    };
  }

  if (descriptor?.changesPlatformBehaviour === true) {
    return {
      kind: "system_change",
      label: approval.requestedBy.actorId,
      actor: actorSummary(approval.requestedBy),
      origin: subject.artifactId ?? subject.roleId,
      runId: approval.runId,
      basis: `"${approval.action}" is declared in the action registry as changing what the platform itself will do next.`,
    };
  }

  return {
    kind: "workflow",
    label: approval.requestedBy.actorId,
    actor: actorSummary(approval.requestedBy),
    origin: subject.workflow ?? subject.workflowName,
    runId: approval.runId,
    basis: approval.runId
      ? "Raised by a workflow step on a run in the operating record."
      : "Raised against the operating record by a platform caller.",
  };
}

// ---------------------------------------------------------------------------
// The ask, the effects, the rejection
// ---------------------------------------------------------------------------

/** Longest a summary may be and still serve as the one-line ask. */
const ASK_LENGTH_LIMIT = 140;

/**
 * The ask, in plain language.
 *
 * Preference order, and each step exists because the one before it can be
 * missing:
 *
 *   1. The registry's declared ask, joined to the subject's headline
 *      reference. Reviewed text, and specific to this case.
 *   2. The proposer's summary, when it is short enough to be a headline and is
 *      not a serialised payload. Written by the code that parked the action.
 *   3. The action's description, first sentence.
 *   4. The action name, humanised — the floor, and never a JSON blob.
 *
 * The `[external agent]` prefix the admission chain writes is stripped when it
 * appears, because the provenance badge now carries that fact and a screen
 * that says it twice has spent its most valuable line on a repeat.
 */
export function askOf(
  approval: ApprovalRequest,
  descriptor: ActionDescriptor | undefined,
  provenance: ApprovalProvenance,
): string {
  const reference = headlineReference(approval.subject);

  const declared = descriptor?.approvalGuidance?.ask;
  if (declared) return reference ? `${declared} — ${reference}` : declared;

  const summary = stripExternalPrefix(approval.summary).trim();
  if (summary.length > 0 && summary.length <= ASK_LENGTH_LIMIT && !looksSerialised(summary)) {
    return summary;
  }

  if (descriptor?.description) {
    const firstSentence = descriptor.description.split(". ")[0] ?? descriptor.description;
    return reference ? `${firstSentence} — ${reference}` : firstSentence;
  }

  if (provenance.kind === "external_agent" && approval.subject.tool) {
    return `Let ${provenance.label} run "${approval.subject.tool}"${reference ? ` — ${reference}` : ""}`;
  }

  const humanised = approval.action.replace(/[._]/g, " ");
  return reference ? `${humanised} — ${reference}` : humanised;
}

function effectsOf(
  approval: ApprovalRequest,
  descriptor: ActionDescriptor | undefined,
  provenance: ApprovalProvenance,
): readonly string[] {
  const declared = descriptor?.approvalGuidance?.effects;
  if (declared) return declared;

  // Unregistered actions reach here — an external agent's tool call under
  // `external.<operation>`. The platform genuinely does not know what that
  // vendor's tool does, and saying so is the only honest line available. It is
  // deliberately uncomfortable to read: an approver should feel the difference
  // between an effect this platform declared and one it is relaying.
  if (provenance.kind === "external_agent") {
    return [
      `${provenance.label} performs "${approval.subject.tool ?? approval.action}" on ${provenance.origin ?? "its own platform"}.`,
      "The effect happens in that system, not in this one. This platform records that it was authorised, at what risk rating, and what it cost.",
      "What the tool actually does is the vendor's declaration, not a capability this platform has classified.",
    ];
  }

  return [
    `The platform performs "${approval.action}".`,
    "No effects are declared for this action in the action registry, so this screen cannot tell you more than its name. Treat that as a reason to ask, not as a reason to assume it is small.",
  ];
}

function ifRejectedOf(
  approval: ApprovalRequest,
  descriptor: ActionDescriptor | undefined,
): string {
  const declared = descriptor?.approvalGuidance?.ifRejected;
  if (declared) return declared;
  return approval.runId
    ? "The action does not happen. The run stops here and comes back to a person, and the rejection reason is captured as improvement signal."
    : "The action does not happen. The request is closed as rejected and the reason is captured as improvement signal.";
}

// ---------------------------------------------------------------------------
// The rule, and the blast radius
// ---------------------------------------------------------------------------

const INVOLVEMENT_WORDS: Readonly<Record<string, string>> = {
  automatic: "the platform may act and a human reviews afterwards",
  proposed_then_approved: "a human approves before the effect lands",
  human_only: "a human performs the action; the platform only gathers evidence",
};

const RISK_WORDS: Readonly<Record<RiskTier, string>> = {
  routine: "routine",
  sensitive: "sensitive",
  high_consequence: "high consequence",
  prohibited: "prohibited",
};

function ruleOf(
  approval: ApprovalRequest,
  descriptor: ActionDescriptor | undefined,
  risk: RiskTier,
): ApprovalRule {
  const approvers =
    approval.approvalsRequired === 1 ? "1 approver" : `${approval.approvalsRequired} approvers`;
  const stepUp = descriptor?.requiresStepUp ?? true;
  const threshold = `${RISK_WORDS[risk]} · ${approvers} · ${stepUp ? "step-up re-authentication" : "no step-up"}`;

  if (!descriptor) {
    return {
      ruleId: approval.action,
      name: `Admission threshold for ${approval.action}`,
      threshold,
      risk,
      humanInvolvement: INVOLVEMENT_WORDS.proposed_then_approved ?? "",
      approvalsRequired: approval.approvalsRequired,
      requiresStepUp: stepUp,
      source: "external_admission",
      registered: false,
    };
  }

  return {
    ruleId: descriptor.name,
    name: ruleName(descriptor),
    threshold,
    risk,
    humanInvolvement: INVOLVEMENT_WORDS[descriptor.humanInvolvement] ?? descriptor.humanInvolvement,
    approvalsRequired: approval.approvalsRequired,
    requiresStepUp: stepUp,
    source: "action_registry",
    registered: true,
  };
}

/** A rule name a person can say out loud, from the machine name. */
function ruleName(descriptor: ActionDescriptor): string {
  const [group, verb] = descriptor.name.split(".");
  if (!verb) return descriptor.name;
  const readable = `${verb.replace(/_/g, " ")} (${(group ?? "").replace(/_/g, " ")})`;
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

function blastRadiusOf(
  approval: ApprovalRequest,
  descriptor: ActionDescriptor | undefined,
): ApprovalBlastRadius {
  const subject = approval.subject;
  const owners = wholeNumber(subject.ownersAffected);
  const money = decimal(subject.amountUsd ?? subject.moneyUsd);

  const jurisdictions = [subject.state, subject.jurisdiction]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .filter((value, index, all) => all.indexOf(value) === index);

  return {
    ownersAffected: owners,
    ownersAffectedUnknown:
      owners === undefined
        ? "The proposal does not state how many owners it reaches, and this platform cannot count them without the contract system of record."
        : undefined,
    moneyUsd: money,
    moneyUnknown:
      money === undefined
        ? "No monetary amount is stated on this proposal. Money moves in MVW's billing systems, which this deployment does not read."
        : undefined,
    reversal:
      descriptor?.approvalGuidance?.reversal ??
      (descriptor?.reversible === true
        ? "No reversal procedure is declared for this action. Confirm with the action's owner before assuming it can be undone."
        : "No reversal procedure is declared, and this action is not marked reversible. Treat it as permanent."),
    jurisdictions,
  };
}

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

/**
 * The exact thing that will be produced or written.
 *
 * A resolver supplied by the deployment wins, and whatever it returns is
 * re-digested here rather than trusted: a document store that returned the
 * *current* version of a template, when the approval was bound to the previous
 * one, would render a preview of something nobody approved. The check is
 * cheap; the failure it prevents is an approver reading one letter and signing
 * another.
 *
 * With no resolver there is still one case the platform can serve honestly. A
 * proposal whose digest is exactly `digestValue(subject)` *is* its subject —
 * the record write is the whole of it — so it can be shown as itself and the
 * match proved rather than asserted.
 */
async function resolveArtifact(
  approval: ApprovalRequest,
  sources: DecisionContextSources,
): Promise<ApprovalArtifact | null> {
  if (sources.artifact) {
    const supplied = await sources.artifact(approval);
    if (supplied) {
      const recomputed = digestBody(supplied);
      return {
        ...supplied,
        digest: recomputed,
        matchesProposalDigest: digestsEqual(recomputed, approval.proposalDigest),
      };
    }
  }

  const subjectDigest = digestValue(approval.subject);
  if (digestsEqual(subjectDigest, approval.proposalDigest)) {
    return {
      kind: "record_write",
      title: "The record write this approval authorises",
      mediaType: "application/json",
      body: JSON.stringify(approval.subject, Object.keys(approval.subject).sort(), 2),
      digest: subjectDigest,
      matchesProposalDigest: true,
    };
  }

  return null;
}

/**
 * Re-digest a supplied artifact the way its producer would have.
 *
 * JSON bodies are digested as the value so key order cannot change the answer;
 * everything else is digested as bytes, because the bytes are the artifact.
 */
function digestBody(artifact: ApprovalArtifact): string {
  if (artifact.mediaType === "application/json") {
    try {
      return digestValue(JSON.parse(artifact.body) as unknown);
    } catch {
      // A body that claims to be JSON and is not is still an artifact; digest
      // what is actually there rather than refusing to show it at all.
      return digestValue(artifact.body);
    }
  }
  return digestValue(artifact.body);
}

// ---------------------------------------------------------------------------
// Prior similar decisions
// ---------------------------------------------------------------------------

/**
 * The last five decisions on the same action, and how each one turned out.
 *
 * This is how an approver calibrates in seconds: five rejections in a row on
 * the same action says something no risk tier can. "How it turned out" is read
 * from the run the approval was spent on, so a granted approval whose run then
 * failed reads as a granted approval whose run then failed — not as a success.
 */
async function priorDecisions(
  approval: ApprovalRequest,
  platform: Platform,
): Promise<readonly PriorDecision[]> {
  const candidates = await platform.approvals.list({
    action: approval.action,
    limit: PRIOR_DECISION_POOL,
  });

  const decided = candidates
    .filter((entry) => entry.id !== approval.id)
    .map((entry) => ({ entry, decision: lastDecision(entry) }))
    .filter(
      (pair): pair is { entry: ApprovalRequest; decision: NonNullable<ReturnType<typeof lastDecision>> } =>
        pair.decision !== undefined,
    )
    .sort((a, b) => b.decision.decidedAt.localeCompare(a.decision.decidedAt))
    .slice(0, PRIOR_DECISION_COUNT);

  const rows: PriorDecision[] = [];
  for (const { entry, decision } of decided) {
    const descriptor = platform.registry.get(entry.action);
    const outcome = await outcomeOf(entry, platform);
    rows.push({
      approvalId: entry.id,
      ask: askOf(entry, descriptor, provenanceOf(entry, descriptor)),
      decidedBy: actorSummary(decision.actor),
      decision: decision.decision,
      decidedAt: decision.decidedAt,
      outcome: outcome.outcome,
      outcomeDetail: outcome.detail,
      runId: entry.consumedByRunId ?? entry.runId,
    });
  }
  return rows;
}

function lastDecision(request: ApprovalRequest) {
  const sorted = [...request.decisions].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  return sorted[sorted.length - 1];
}

async function outcomeOf(
  request: ApprovalRequest,
  platform: Platform,
): Promise<{ readonly outcome: PriorOutcome; readonly detail: string }> {
  if (request.status === "rejected") {
    return { outcome: "not_carried_out", detail: "Rejected — the action never happened." };
  }
  if (request.status === "expired") {
    return {
      outcome: "not_carried_out",
      detail: "Granted, then expired before it was used. The action never happened.",
    };
  }

  const runId = request.consumedByRunId;
  if (!runId) {
    return request.status === "granted"
      ? {
          outcome: "awaiting_execution",
          detail: "Granted, and not yet spent. The action has not happened yet.",
        }
      : { outcome: "unknown", detail: `Recorded as ${request.status}.` };
  }

  const run = await platform.runs.getRun(runId as Id<"run">);
  if (!run) {
    return {
      outcome: "unknown",
      detail: `Spent on run ${runId}, which is no longer in the operating record.`,
    };
  }
  return { outcome: runOutcome(run), detail: runOutcomeDetail(run) };
}

function runOutcome(run: Run): PriorOutcome {
  switch (run.status) {
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "denied":
      return "refused";
    case "cancelled":
      return "not_carried_out";
    default:
      return "awaiting_execution";
  }
}

function runOutcomeDetail(run: Run): string {
  if (run.outcome) return run.outcome;
  if (run.denialReason) return run.denialReason;
  switch (run.status) {
    case "succeeded":
      return "The action completed.";
    case "failed":
      return "The run failed after the approval was spent.";
    case "denied":
      return "The platform refused the action after it was approved.";
    case "cancelled":
      return "The run was cancelled after the approval was spent.";
    default:
      return `The run is ${run.status.replace(/_/g, " ")}.`;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Whether this viewer may decide, and why not.
 *
 * Segregation of duties is enforced server-side at decision time. Reporting it
 * here as well lets the console disable the control and say why, which is
 * considerably kinder than letting someone click and be refused.
 */
function viewerEligibility(
  approval: ApprovalRequest,
  viewer: ActorRef,
): { readonly viewerMayDecide: boolean; readonly viewerMayNotDecideReason?: string } {
  const isRequester = viewer.actorId === approval.requestedBy.actorId;
  const alreadyDecided = approval.decisions.some((entry) => entry.actor.actorId === viewer.actorId);
  const eligible = viewer.roles.some((role) => approval.eligibleRoles.includes(role));

  let reason: string | undefined;
  if (approval.status !== "pending") reason = `This request is ${approval.status}.`;
  else if (isRequester) reason = "You requested this action, so you cannot approve it.";
  else if (alreadyDecided) reason = "You have already decided on this request.";
  else if (!eligible) {
    reason = `Approving this needs one of: ${approval.eligibleRoles.join(", ")}.`;
  }

  return reason === undefined
    ? { viewerMayDecide: true }
    : { viewerMayDecide: false, viewerMayNotDecideReason: reason };
}

function riskOf(approval: ApprovalRequest, descriptor: ActionDescriptor | undefined): RiskTier {
  if (descriptor) return descriptor.risk;
  // The admission chain floors the agent's declared risk with the operator's
  // rating and writes the result onto the subject. Reading it back is not
  // trusting the agent; it is reading what this platform decided.
  const effective = approval.subject.effectiveRisk;
  if (
    effective === "routine" ||
    effective === "sensitive" ||
    effective === "high_consequence" ||
    effective === "prohibited"
  ) {
    return effective;
  }
  // An action nobody classified is treated as the most serious thing it could
  // be, which is the same rule the chokepoint applies.
  return "high_consequence";
}

function describeUnregistered(approval: ApprovalRequest): string {
  return approval.subject.principal === "external"
    ? `An external agent's operation. "${approval.action}" is not a registered platform action, so this platform has not classified what it does.`
    : `"${approval.action}" is not in the action registry.`;
}

function actorSummary(actor: ActorRef) {
  return { actorId: actor.actorId, displayName: actor.actorId, roles: actor.roles };
}

/** The subject reference an approver recognises, for the headline line. */
function headlineReference(subject: Readonly<Record<string, string>>): string | undefined {
  return (
    subject.contractId ??
    subject.associationId ??
    subject.membershipId ??
    subject.loanId ??
    subject.ownerRef ??
    subject.roleId ??
    subject.artifactId ??
    subject.externalAgentId
  );
}

function stripExternalPrefix(summary: string): string {
  return summary.startsWith("[external agent] ") ? summary.slice("[external agent] ".length) : summary;
}

/** True when the text is a payload rather than a sentence. */
function looksSerialised(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("sha256:") ||
    /"[A-Za-z0-9_]+"\s*:/.test(trimmed)
  );
}

function wholeNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function decimal(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
