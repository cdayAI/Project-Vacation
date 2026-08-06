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

/** One row in the work queue. */
export interface WorkQueueItem {
  readonly runId: string;
  readonly kind: string;
  readonly title: string;
  readonly status: RunStatus;
  readonly mode: OperatingMode;
  readonly createdAt: string;
  readonly dueAt?: string;
  /** True when the item has passed its SLA. Rendered prominently, not buried. */
  readonly slaBreached: boolean;
  readonly assignedRole?: string;
  readonly costUsd: number;
  /** Short plain-language statement of what it is waiting for, if anything. */
  readonly waitingOn?: string;
}

/**
 * An approval request as an approver sees it.
 *
 * The console's job here is to show *exactly what is being authorised*. The
 * proposal digest is displayed because it is the thing the approval binds to —
 * an approver should be able to see that the artifact they read is the artifact
 * their decision covers.
 */
export interface ApprovalView {
  readonly approvalId: string;
  readonly action: string;
  readonly actionDescription: string;
  readonly risk: RiskTier;
  readonly reversible: boolean;
  readonly summary: string;
  readonly proposalDigest: string;
  /** The proposal rendered for a human, field by field. */
  readonly proposal: readonly { readonly label: string; readonly value: string }[];
  readonly requestedBy: ActorSummary;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly approvalsRequired: number;
  readonly approvalsGranted: number;
  readonly eligibleRoles: readonly string[];
  readonly decisions: readonly {
    readonly actor: ActorSummary;
    readonly decision: "granted" | "rejected";
    readonly decidedAt: string;
    readonly note?: string;
  }[];
  /** False, with a reason, when this viewer may not decide — e.g. self-approval. */
  readonly viewerMayDecide: boolean;
  readonly viewerMayNotDecideReason?: string;
  readonly requiresStepUp: boolean;
}

export interface StepView {
  readonly stepId: string;
  readonly seq: number;
  readonly name: string;
  readonly kind: string;
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
