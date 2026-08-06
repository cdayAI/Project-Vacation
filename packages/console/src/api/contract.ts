/**
 * The console's data contract.
 *
 * These are view models, not the platform's internal domain types. The API maps
 * one to the other.
 *
 * That indirection is deliberate. The console is a separate deliverable with a
 * separate release cadence, and coupling it to internal types would mean every
 * refactor inside the platform became a console change. It also lets the API be
 * the place where data minimisation is applied on the way out: a view model
 * carries what a screen needs to render and nothing else, so a field that
 * should not reach a browser cannot leak by being present on a domain object
 * that happened to be serialised.
 *
 * Every timestamp is an ISO-8601 UTC string. Formatting for display happens in
 * the browser, in the viewer's locale and timezone.
 */

export type OperatingMode = "shadow" | "assisted" | "supervised" | "bounded_autonomy";

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_human"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "denied";

export type RiskTier = "routine" | "sensitive" | "high_consequence" | "prohibited";

export interface ActorSummary {
  readonly actorId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

/** The signed-in user, and what the console should let them see and do. */
export interface SessionView {
  readonly actor: ActorSummary;
  readonly secondsSinceAuthentication: number;
  /**
   * Capabilities the console uses to decide whether to render a control.
   *
   * This is a rendering hint, never an authorization decision. The server
   * re-checks every action at the chokepoint; hiding a button is a courtesy to
   * the user, not a control.
   */
  readonly capabilities: readonly string[];
  /** True for the auditor role: sees everything, changes nothing. */
  readonly readOnly: boolean;
}

// ---------------------------------------------------------------------------
// The work queue — design specification §3.1
// ---------------------------------------------------------------------------

/**
 * The owner a piece of work is about.
 *
 * `accountRef` is the opaque reference the operating record holds. `name` is
 * absent unless an owner system of record is connected, and `nameUnknown` says
 * so — the record is deliberately built to hold references rather than names,
 * so a missing name here is the platform working correctly rather than a bug.
 */
export interface WorkQueueOwner {
  readonly accountRef: string;
  readonly name?: string;
  readonly nameUnknown?: string;
}

/** How a row's assignment is known. Three states, not two. */
export type AssignmentState =
  /** Somebody or some role owns it. */
  | "assigned"
  /** Nobody owns it, and the platform knows that. */
  | "unassigned"
  /**
   * The platform does not model assignment for this work.
   *
   * Distinct from `unassigned` on purpose. "Nobody has picked this up" is a
   * call to action; "we do not track who picked this up" is a gap in the
   * deployment, and an operator does something different about each.
   */
  | "not_tracked";

/**
 * One row in the work queue.
 *
 * The design specification fixes seven columns: status, what, owner, age,
 * value, assignee, next action. Four of those come out of the operating record
 * and three depend on systems this deployment may not read, so each of those
 * three is optional and carries a sentence explaining its absence. The console
 * renders the sentence. It never renders a zero in place of a number nobody
 * has.
 *
 * **The age band is computed here, not sent.** `slaStartedAt` and `dueAt` are
 * the target; the console decides where neutral becomes warning and warning
 * becomes danger. A colour on the wire would put a design threshold in a
 * serialiser, where the two densities could disagree about it and where
 * changing it would be an API change.
 */
export interface WorkQueueItem {
  readonly runId: string;
  readonly kind: string;
  readonly title: string;
  /** The second line under the title. Context, never a restatement. */
  readonly subtitle?: string;
  readonly status: RunStatus;
  readonly mode: OperatingMode;
  readonly createdAt: string;
  /** When the SLA clock started. Not always `createdAt`. */
  readonly slaStartedAt?: string;
  readonly dueAt?: string;
  /** The named policy behind the target, so the number is attributable. */
  readonly slaPolicy?: string;
  /** Present when no target is declared for this kind of work. */
  readonly slaTargetUnknown?: string;
  /** True when the item has passed its SLA. Rendered prominently, not buried. */
  readonly slaBreached: boolean;
  readonly owner?: WorkQueueOwner;
  readonly ownerUnknown?: string;
  /** Case value in US dollars. Absent when no billing system is connected. */
  readonly valueUsd?: number;
  readonly valueUnknown?: string;
  readonly assignment: AssignmentState;
  readonly assignee?: ActorSummary;
  readonly assignedRole?: string;
  /** The next action as a verb phrase: "Approve or reject the parked action". */
  readonly nextAction: string;
  readonly nextActionApprovalId?: string;
  /** What the platform has spent on this run. Never the case's value. */
  readonly costUsd: number;
  /** Short plain-language statement of what it is waiting for, if anything. */
  readonly waitingOn?: string;
}

/** The saved views the filter bar offers as pills. */
export type SavedView = "all_open" | "mine" | "breaching" | "high_value" | "unassigned";

export type WorkQueueSort =
  | "age_desc"
  | "age_asc"
  | "due_soonest"
  | "value_desc"
  | "cost_desc"
  | "status";

/**
 * A page of work, and the state that produced it.
 *
 * `totalIsExact` is here because three of the filters — assignee, breaching,
 * high value — cannot be pushed into the store: assignment is not a column,
 * breach is a function of the clock against a target table, and value comes
 * from a system nobody has connected. They are resolved over a bounded window,
 * and when that window is full the count is of what was examined rather than
 * of what exists. A result count that quietly rounds down is how a supervisor
 * concludes the queue is shorter than it is.
 */
export interface WorkQueuePage extends Page<WorkQueueItem> {
  readonly totalIsExact: boolean;
  readonly view?: SavedView;
  readonly sort: WorkQueueSort;
  /** The floor the "High value" view uses, so the console can name it. */
  readonly highValueFloorUsd: number;
}

// ---------------------------------------------------------------------------
// The approval — design specification §3.2, the hero screen
// ---------------------------------------------------------------------------

/**
 * Which of three trust situations this request is.
 *
 * A colleague's workflow, a vendor's agent running in somebody else's product,
 * and a change to what the platform itself will do are three different things
 * to be asked to authorise. The screen badges them distinctly, and the
 * platform derives the kind from the record — the external-agent marker, the
 * action's own declaration — never from the wording of a summary.
 */
export type ProvenanceKind = "workflow" | "external_agent" | "system_change";

export interface ApprovalProvenance {
  readonly kind: ProvenanceKind;
  /** Who or what asked, as the badge reads it. */
  readonly label: string;
  readonly actor: ActorSummary;
  /** Where an external agent runs, or the workflow behind a run. */
  readonly origin?: string;
  /** The person accountable for an external agent. Never a shared mailbox. */
  readonly accountable?: string;
  readonly runId?: string;
  /** Why the platform classified it this way. */
  readonly basis: string;
}

export type ApprovalArtifactKind =
  | "letter"
  | "message"
  | "document"
  | "record_write"
  | "configuration";

/**
 * The exact thing that will be produced or written.
 *
 * `matchesProposalDigest` is the field that makes an inline preview safe to
 * trust: it is true only when re-digesting `body` reproduces the digest the
 * approval binds to. False means the platform is showing something that
 * *describes* the proposal, and the console must say so — otherwise an
 * approver reads one letter and signs another, which is the exact attack
 * digest binding exists to close.
 */
export interface ApprovalArtifact {
  readonly kind: ApprovalArtifactKind;
  readonly title: string;
  readonly mediaType: string;
  readonly body: string;
  readonly digest: string;
  readonly matchesProposalDigest: boolean;
}

/** The named rule and its threshold, with enough identity to link to it. */
export interface ApprovalRule {
  readonly ruleId: string;
  readonly name: string;
  /** One line: tier, approvers, step-up. */
  readonly threshold: string;
  readonly risk: RiskTier;
  readonly humanInvolvement: string;
  readonly approvalsRequired: number;
  readonly requiresStepUp: boolean;
  readonly source: "action_registry" | "external_admission";
  /**
   * False when the action is not a registered platform action.
   *
   * External agents raise approvals under their own tool names, which this
   * platform has deliberately not classified. The screen says the threshold
   * came from the admission chain rather than implying a registry entry that
   * does not exist.
   */
  readonly registered: boolean;
}

/**
 * Who and what this reaches.
 *
 * Note what is *not* here: whether the action can be undone. That is
 * `ApprovalView.reversible`, declared once on the action itself. Repeating it
 * would be two places to change one fact, and they would eventually disagree.
 * `reversal` is the procedure, which is a different thing from the flag.
 */
export interface ApprovalBlastRadius {
  readonly ownersAffected?: number;
  readonly ownersAffectedUnknown?: string;
  readonly moneyUsd?: number;
  readonly moneyUnknown?: string;
  readonly reversal: string;
  readonly jurisdictions: readonly string[];
}

/** One evidence item, checkable inline without navigating away. */
export interface EvidenceItem {
  readonly citationId: string;
  readonly source: string;
  readonly version: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly jurisdiction?: string;
  /** The exact passage. Never a summary of it. */
  readonly passage: string;
  readonly sourceUri?: string;
  readonly stale: boolean;
}

export type PriorOutcome =
  | "completed"
  | "failed"
  | "refused"
  | "not_carried_out"
  | "awaiting_execution"
  | "unknown";

/**
 * One earlier decision on the same action, and how it turned out.
 *
 * The single highest-value field on this screen. Five rejections in a row on
 * the same action tells an approver something no risk tier can, and the
 * outcome is read from the run the approval was spent on — so a grant whose
 * run then failed reads as exactly that, not as a success.
 */
export interface PriorDecision {
  readonly approvalId: string;
  readonly ask: string;
  readonly decidedBy: ActorSummary;
  readonly decision: "granted" | "rejected";
  readonly decidedAt: string;
  readonly outcome: PriorOutcome;
  readonly outcomeDetail: string;
  readonly runId?: string;
}

/**
 * An approval as the queue lists it.
 *
 * Everything needed to triage, and nothing that costs a per-approval read.
 * The evidence, the artifact preview, and the prior-decision lookback are on
 * `ApprovalDetailView` instead, because running them for a hundred rows nobody
 * has opened would make the queue slow in exact proportion to how carefully
 * the detail screen was built.
 */
export interface ApprovalView {
  readonly approvalId: string;
  readonly action: string;
  readonly actionDescription: string;
  /** The ask in plain language: "Send a message to an owner — CTR-2026-FL-0184423". */
  readonly ask: string;
  readonly risk: RiskTier;
  readonly reversible: boolean;
  readonly summary: string;
  readonly proposalDigest: string;
  readonly provenance: ApprovalProvenance;
  /** Up to four concrete consequences of approving. */
  readonly effects: readonly string[];
  /** One line: what happens instead if this is rejected. */
  readonly ifRejected: string;
  readonly rule: ApprovalRule;
  readonly blastRadius: ApprovalBlastRadius;
  readonly requestedBy: ActorSummary;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly approvalsRequired: number;
  readonly approvalsGranted: number;
  readonly eligibleRoles: readonly string[];
  /** False, with a reason, when this viewer may not decide — e.g. self-approval. */
  readonly viewerMayDecide: boolean;
  readonly viewerMayNotDecideReason?: string;
  readonly requiresStepUp: boolean;
  readonly runId?: string;
  /**
   * The proposal rendered for a human, field by field.
   *
   * On the queue row rather than the detail view because it costs nothing: it
   * is the approval's own subject map, already loaded. The three fields that
   * *do* cost a read each are on `ApprovalDetailView`.
   */
  readonly proposal: readonly { readonly label: string; readonly value: string }[];
  /** Decisions already recorded. Also already loaded, so also free. */
  readonly decisions: readonly {
    readonly actor: ActorSummary;
    readonly decision: "granted" | "rejected";
    readonly decidedAt: string;
    readonly note?: string;
  }[];
}

/**
 * An approval request as an approver sees it, in full.
 *
 * The console's job here is to show *exactly what is being authorised*. The
 * proposal digest is displayed because it is the thing the approval binds to —
 * an approver should be able to see that the artifact they read is the artifact
 * their decision covers.
 */
export interface ApprovalDetailView extends ApprovalView {
  readonly artifact?: ApprovalArtifact;
  /** Present when there is no artifact to preview, saying why. */
  readonly artifactUnknown?: string;
  readonly evidence: readonly EvidenceItem[];
  readonly evidenceUnknown?: string;
  readonly priorDecisions: readonly PriorDecision[];
}

// ---------------------------------------------------------------------------
// Run detail — design specification §3.3
// ---------------------------------------------------------------------------

/** The five step types the timeline draws an icon for. */
export type StepType = "retrieval" | "model" | "action" | "human" | "wait";

/** A statement the platform made that no citation supports. */
export interface AssertedStatement {
  readonly text: string;
  /** Digest of the output it belongs to, so it can be traced. */
  readonly outputDigest?: string;
}

/** A value the platform worked out itself, with how it got there. */
export interface ComputedValue {
  readonly label: string;
  readonly value: string;
  /** The rule and inputs behind it. Empty when the step recorded none. */
  readonly derivation: string;
}

/**
 * What a step retrieved, what it asserted, and what it computed.
 *
 * The honest core of this product. A supervisor reading a run has to be able
 * to tell a **citation** from a **claim**: a passage pulled from a governed
 * source, a statement the platform made on its own, and a value it derived
 * from rules are three different kinds of trust. A timeline that renders them
 * identically teaches people to trust all three equally, which is the failure
 * this distinction exists to prevent.
 *
 * `recorded` says which of two things this is. True: the step declared its own
 * provenance, and this is testimony. False: it was derived from the step's kind
 * and whatever detail it happened to keep, and this is inference. The console
 * renders the two differently, and it must — presenting inference as evidence
 * on the screen whose whole purpose is telling evidence from inference would be
 * the one unforgivable bug here.
 */
export interface StepProvenance {
  readonly retrieved: readonly CitationView[];
  readonly asserted: readonly AssertedStatement[];
  readonly computed: readonly ComputedValue[];
  readonly recorded: boolean;
  readonly basis: string;
}

/** Who did a human step, and how long they took. */
export interface HumanStepDetail {
  readonly actor?: ActorSummary;
  readonly actorUnknown?: string;
  /** Absent while the task is still open. */
  readonly tookMs?: number;
}

/** What happened on a failed step, and the retry or escalation that followed. */
export interface StepFailureDetail {
  readonly what: string;
  readonly attempt: number;
  readonly followedBy: string;
  readonly followedByStepId?: string;
}

export interface StepView {
  readonly stepId: string;
  readonly seq: number;
  readonly name: string;
  /** The raw machine kind. An engineer reading a bug needs it. */
  readonly kind: string;
  /** The five-way type the timeline draws. */
  readonly type: StepType;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly costUsd: number;
  readonly attempt: number;
  readonly inputDigest?: string;
  readonly outputDigest?: string;
  readonly error?: string;
  /** Present when the step was refused. The reason code, plainly worded. */
  readonly denialReason?: string;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
  readonly provenance?: StepProvenance;
  readonly human?: HumanStepDetail;
  readonly failure?: StepFailureDetail;
  /** Sources this step cited. Empty is a claim about the step, not a gap. */
  readonly citations: readonly CitationView[];
  /**
   * Whether "correct this" is offered on this step.
   *
   * Only where a correction means something — a model call or a retrieval that
   * produced an output a person can disagree with. Offering it on a timer
   * would collect signal nobody can act on, and the improvement loop ranks by
   * frequency, so noise there steers which real failure gets attention.
   */
  readonly correctable: boolean;
}

/**
 * A correction, as the console submits it.
 *
 * `signature` is a controlled vocabulary in dotted lower_snake_case, not free
 * text, because clustering groups on it: a prose summary produces one cluster
 * per typist and nothing ever recurs.
 */
export interface CorrectionRequest {
  readonly signature: string;
  readonly note: string;
  /** Human minutes the correction cost. Half the improvement loop's ranking. */
  readonly correctionMinutes?: number;
  /** What the platform produced. Fingerprinted server-side, never stored raw. */
  readonly before?: string;
  /** What the person replaced it with. Also fingerprinted, never stored raw. */
  readonly after?: string;
  readonly idempotencyKey: string;
}

/**
 * What the platform did with a correction.
 *
 * `effect` is deliberately part of the payload rather than copy in a
 * component. A correction is inert evidence: it changes nothing on its own,
 * and the sentence saying so belongs beside the thing it is true of. The
 * improvement gate needs a recorded human approval and there is no
 * configuration that removes it (ADR 0011).
 */
export interface CorrectionView {
  readonly observationId: string;
  /** False when an identical correction was already recorded. */
  readonly recorded: boolean;
  readonly signature: string;
  readonly recordedAt: string;
  readonly effect: string;
}

/** A run with its full step trail — the per-run detail view. */
export interface RunDetailView {
  readonly runId: string;
  readonly kind: string;
  readonly title: string;
  readonly status: RunStatus;
  readonly mode: OperatingMode;
  readonly requestedBy: ActorSummary;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** Wall-clock elapsed, for the sticky header. Absent while still running. */
  readonly elapsedMs?: number;
  readonly outcome?: string;
  readonly denialReason?: string;
  readonly steps: readonly StepView[];
  readonly totalCostUsd: number;
  readonly costByCategory: Readonly<Record<string, number>>;
  readonly workflowInstanceId?: string;
  readonly roleId?: string;
  readonly roleVersion?: number;
  /** Citations produced during the run, so a reviewer can click through. */
  readonly citations: readonly CitationView[];
}

export interface CitationView {
  readonly chunkId: string;
  readonly documentTitle: string;
  readonly documentVersion: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly jurisdiction?: string;
  readonly excerpt: string;
  readonly sourceUri?: string;
  /** True when the corpus is past its review cadence. Shown as a warning. */
  readonly stale: boolean;
}

/** A workflow instance, described so a supervisor can read it unaided. */
export interface WorkflowInstanceView {
  readonly instanceId: string;
  readonly definitionName: string;
  readonly definitionVersion: number;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Plain language: where it is, why it is stuck, what it is waiting for. */
  readonly plainLanguageStatus: string;
  readonly currentStepName?: string;
  readonly waitingOn?: string;
  readonly totalCostUsd: number;
  readonly steps: readonly {
    readonly name: string;
    readonly kind: string;
    readonly status: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly dueAt?: string;
    readonly slaBreached: boolean;
  }[];
}

export interface RoleView {
  readonly roleId: string;
  readonly name: string;
  readonly purpose: string;
  readonly version: number;
  readonly status: "draft" | "proposed" | "promoted" | "disabled" | "reverted";
  readonly riskCeiling: RiskTier;
  readonly humanInvolvement: string;
  readonly modelTask: string;
  readonly allowedActions: readonly string[];
  readonly dataScopes: readonly string[];
  readonly updatedAt: string;
  readonly updatedBy: ActorSummary;
  readonly latestEvaluation?: EvaluationView;
  readonly disabled: boolean;
}

export interface EvaluationView {
  readonly evaluationId: string;
  readonly ranAt: string;
  readonly goldenSetName: string;
  readonly caseCount: number;
  readonly passed: number;
  readonly accuracy: number;
  readonly threshold: number;
  readonly meetsThreshold: boolean;
  readonly modelId: string;
  readonly promptVersion: string;
}

/** An improvement proposal, with everything an approver needs in one view. */
export interface ImprovementProposalView {
  readonly proposalId: string;
  readonly kind: string;
  readonly title: string;
  readonly rationale: string;
  readonly artifactKind: string;
  readonly artifactRef: string;
  readonly before: string;
  readonly after: string;
  readonly evaluationBefore?: EvaluationView;
  readonly evaluationAfter?: EvaluationView;
  /** Percentage-point change in measured accuracy. */
  readonly evaluationDelta?: number;
  /** What this change would touch, computed from the operating record. */
  readonly blastRadius: {
    readonly roles: readonly string[];
    readonly workflows: readonly string[];
    readonly runsInLastThirtyDays: number;
  };
  readonly observationCount: number;
  readonly createdAt: string;
  readonly status: string;
}

export interface ImprovementClusterView {
  readonly clusterId: string;
  readonly summary: string;
  readonly roleId?: string;
  readonly occurrences: number;
  readonly ratePercent: number;
  readonly estimatedCostUsd: number;
  readonly exampleRunIds: readonly string[];
}

export interface AuditEntryView {
  readonly entryId: string;
  readonly seq: number;
  readonly eventType: string;
  readonly recordedAt: string;
  readonly actor: ActorSummary;
  readonly runId?: string;
  readonly subject: Readonly<Record<string, string>>;
  readonly decision: Readonly<Record<string, string | number | boolean>>;
  readonly inputDigests: Readonly<Record<string, string>>;
  readonly entryHash: string;
  readonly previousHash: string;
}

export interface AuditVerificationView {
  readonly intact: boolean;
  readonly entriesChecked: number;
  readonly firstSeq: number | null;
  readonly lastSeq: number | null;
  readonly headHash: string | null;
  readonly verifiedAt: string;
  readonly breaks: readonly {
    readonly kind: string;
    readonly seq: number;
    readonly detail: string;
  }[];
}

export interface ContainmentView {
  readonly scope: "global" | "workflow" | "role" | "integration";
  readonly target: string;
  readonly engaged: boolean;
  readonly engagedBy?: string;
  readonly engagedAt?: string;
  readonly reason?: string;
}

/** The discovery backlog, shown only when the feature is enabled. */
export interface DiscoveryCandidateView {
  readonly candidateId: string;
  readonly summary: string;
  readonly occurrences: number;
  readonly estimatedMinutesPerOccurrence: number;
  readonly applications: readonly string[];
  /** Always true. Discovery output is inert: it cannot be activated from here. */
  readonly draftOnly: true;
}

/**
 * The executive view, tied to the metrics management named in the Q2 2026
 * earnings release.
 *
 * `sourceNote` is required rather than optional on purpose. Some of these
 * numbers come from MVW's own reporting and some from this platform, and a view
 * that blurs the two would invite the platform to be credited for movement it
 * did not cause. Every tile says where its number came from.
 */
export interface ExecutiveMetricView {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly comparison?: string;
  readonly direction?: "up" | "down" | "flat";
  /** Whether an increase is good. Colour must never imply the wrong thing. */
  readonly increaseIsGood?: boolean;
  readonly sourceNote: string;
}

export interface ExecutiveView {
  readonly asOf: string;
  readonly businessMetrics: readonly ExecutiveMetricView[];
  readonly platformMetrics: readonly ExecutiveMetricView[];
  readonly costPerCaseUsd?: number;
  readonly runsCompleted: number;
  readonly humanHoursSaved?: number;
  /** Stated plainly wherever savings are shown and not yet measured. */
  readonly measurementCaveat: string;
}

// ---------------------------------------------------------------------------
// External agents — the ones MVW already runs elsewhere
// ---------------------------------------------------------------------------

/**
 * An agent running outside this platform, as the roster shows it.
 *
 * Two fields are worth reading carefully.
 *
 * `credentialKinds` names WHICH kinds of credential this agent holds and never
 * carries a value, a hash, or a key. There is nothing to carry: a bearer token
 * is stored as a hash and shown once at mint, an HMAC secret is stored as a
 * name resolved from a secret manager. This field exists so an operator can see
 * that an agent authenticates with a signed request rather than a string —
 * which is a real difference in exposure — without the console ever being a
 * place a credential could leak from.
 *
 * `spentUsd` is spend for the CURRENT budget period, named in `periodKey`, and
 * never a lifetime total dressed up as one. A monthly ceiling compared against
 * an all-time figure would show every long-lived agent as permanently over
 * budget, and an operator who learns to ignore that column has lost the alert.
 */
export type ExternalAgentStatus = "active" | "contained" | "revoked";
export type CredentialKind = "bearer" | "jwt" | "hmac" | "envelope";
export type BudgetPeriod = "monthly" | "lifetime";

export interface ExternalAgentView {
  readonly agentId: string;
  readonly name: string;
  /** The person accountable for it. Never a shared mailbox. */
  readonly owner: string;
  readonly department: string;
  /** Where it actually runs — a CRM, a cloud agent service, a bought product. */
  readonly hostPlatform: string;
  readonly purpose: string;
  readonly status: ExternalAgentStatus;
  readonly statusReason?: string;
  readonly statusChangedAt?: string;
  readonly statusChangedBy?: string;
  readonly riskCeiling: RiskTier;
  readonly budgetPeriod: BudgetPeriod;
  /** `lifetime`, or `YYYY-MM`. The period the figures below belong to. */
  readonly periodKey: string;
  readonly spentUsd: number;
  readonly spendCeilingUsd: number;
  readonly overBudget: boolean;
  readonly allowedTools: readonly string[];
  readonly dataScopes: readonly string[];
  /** Which kinds are held. Never a value — see the note above. */
  readonly credentialKinds: readonly CredentialKind[];
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly lastSeenAt?: string;
}

export interface ExternalCredentialView {
  readonly credentialId: string;
  readonly kind: CredentialKind;
  /** The operator's label, e.g. "crm production". Not a value. */
  readonly label: string;
  /** True when the credential proves possession of a key, not of a string. */
  readonly strong: boolean;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly revokedBy?: string;
  readonly revokedReason?: string;
  readonly lastUsedAt?: string;
}

export type ExternalRunStatus = "running" | "finished" | "failed" | "stopped" | "reclaimed";

export interface ExternalAgentRunView {
  readonly externalRunId: string;
  /** The run on the operating record. External work is not a separate table. */
  readonly runId: string;
  readonly goal: string;
  readonly status: ExternalRunStatus;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outcome?: string;
  readonly costUsd: number;
}

/**
 * A refusal, as it was recorded.
 *
 * `reason` is the machine code and `message` is what the platform said at the
 * time. Neither is turned into plain language here: the console does that at
 * render time, from the code, so the wording can be written for the supervisor
 * reading it without changing what the record says.
 */
export interface ExternalAgentDenialView {
  readonly entryId: string;
  readonly recordedAt: string;
  readonly reason: string;
  readonly message?: string;
  readonly tool?: string;
  readonly operation?: string;
  readonly runId?: string;
  /**
   * Whether this counted toward automatic containment.
   *
   * Our own infrastructure failing does not count. Showing which denials were
   * the agent's fault and which were ours is the difference between "this
   * vendor is misbehaving" and "we had an outage".
   */
  readonly countedTowardContainment: boolean;
}

export interface ExternalContainmentEventView {
  readonly at: string;
  readonly change: "contained" | "released" | "revoked";
  readonly by: string;
  /** True when the rate limiter contained it rather than a person. */
  readonly automatic: boolean;
  readonly reason?: string;
  readonly previousStatus?: string;
}

export type ExternalParkedActionStatus =
  | "pending"
  | "approved"
  | "committing"
  | "committed"
  | "rejected"
  | "voided"
  | "expired"
  | "indeterminate";

export interface ExternalParkedActionView {
  readonly parkedActionId: string;
  readonly integration: string;
  readonly operation: string;
  readonly status: ExternalParkedActionStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly committedAt?: string;
  readonly resultSummary?: string;
  readonly approvalId?: string;
}

export interface ExternalSpendMeterView {
  readonly periodKey: string;
  readonly spentUsd: number;
  readonly updatedAt: string;
}

/** One external agent in full: what it did, what it cost, what was refused. */
export interface ExternalAgentDetailView {
  readonly agent: ExternalAgentView;
  readonly credentials: readonly ExternalCredentialView[];
  readonly runs: readonly ExternalAgentRunView[];
  /** Total runs on the record, which can exceed the sample in `runs`. */
  readonly runsTotal: number;
  readonly denials: readonly ExternalAgentDenialView[];
  readonly containmentHistory: readonly ExternalContainmentEventView[];
  readonly parkedActions: readonly ExternalParkedActionView[];
  readonly spendMeters: readonly ExternalSpendMeterView[];
}

/**
 * The four external-agent conditions an operator needs without asking.
 *
 * Carried on the health payload rather than behind their own endpoint, because
 * the point of them is to reach somebody who did not come looking.
 */
export interface ExternalAgentHealthView {
  /** False when this deployment has the plane switched off entirely. */
  readonly planeEnabled: boolean;
  readonly enrolledCount: number;
  readonly activeCount: number;
  /**
   * On, and empty.
   *
   * The most misleading state this plane can be in: every external figure the
   * platform reports is then a zero it has not earned.
   */
  readonly enabledWithNothingEnrolled: boolean;
  readonly contained: readonly {
    readonly agentId: string;
    readonly name: string;
    readonly owner: string;
    readonly department: string;
    readonly hostPlatform: string;
    readonly reason?: string;
    readonly since?: string;
    readonly by?: string;
  }[];
  readonly overBudget: readonly {
    readonly agentId: string;
    readonly name: string;
    readonly owner: string;
    readonly department: string;
    readonly periodKey: string;
    readonly budgetPeriod: BudgetPeriod;
    readonly spentUsd: number;
    readonly ceilingUsd: number;
    readonly overByUsd: number;
  }[];
  readonly credentialsNearingExpiry: readonly {
    readonly credentialId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly kind: CredentialKind;
    readonly label: string;
    readonly expiresAt: string;
    readonly expired: boolean;
  }[];
  readonly expiryHorizonDays: number;
}

export interface HealthView {
  readonly status: "ok" | "degraded" | "unavailable";
  readonly environment: string;
  readonly store: string;
  readonly sandboxMode: string;
  readonly sandboxIsContained: boolean;
  readonly discoveryEnabled: boolean;
  readonly modelProvider: string;
  readonly auditHeadSeq: number | null;
  readonly lastAuditVerification?: AuditVerificationView;
  readonly containment: readonly ContainmentView[];
  /**
   * Optional so an older platform's payload still renders.
   *
   * Absent means "this deployment's health payload does not report on external
   * agents", which is a different statement from "the plane is off" — and the
   * console says so rather than rendering a reassuring blank.
   */
  readonly externalAgents?: ExternalAgentHealthView;
  /** Loud configuration warnings from startup, surfaced to operators. */
  readonly warnings: readonly string[];
}

/** Every list endpoint returns this shape. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * A refusal, as the console receives it.
 *
 * Denials are first-class outcomes in this platform, not errors, and the
 * console renders them as such: what was refused, why, in plain language, and
 * what the user can do about it.
 */
export interface DenialView {
  readonly denied: true;
  readonly reason: string;
  readonly message: string;
  readonly detail: Readonly<Record<string, string | number | boolean>>;
}
