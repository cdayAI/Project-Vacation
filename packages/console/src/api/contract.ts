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
