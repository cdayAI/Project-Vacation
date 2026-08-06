import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, IsoTimestamp, OperatingMode } from "../record/types.js";

/**
 * Risk tier for an action.
 *
 * Every action the platform can take is classified explicitly. There is no
 * default tier and no inference from the action's name: an unregistered action
 * is refused rather than treated as routine, because the failure mode of
 * guessing is that a consequential action slips through as harmless.
 */
export type RiskTier =
  /** No external effect, or an effect that is trivially reversible. */
  | "routine"
  /** Real effect, reversible with effort, no direct consumer consequence. */
  | "sensitive"
  /** Irreversible, consumer-facing, legally significant, or costly. */
  | "high_consequence"
  /** Never permitted by this platform, whatever the configuration says. */
  | "prohibited";

export const RISK_TIERS: readonly RiskTier[] = [
  "routine",
  "sensitive",
  "high_consequence",
  "prohibited",
];

/** How a human is involved, by tier. This is the human-in-the-loop policy. */
export type HumanInvolvement =
  /** The platform acts; a human can review afterwards. */
  | "automatic"
  /** The platform prepares; a human approves before the effect lands. */
  | "proposed_then_approved"
  /** The platform gathers evidence; a human performs the action. */
  | "human_only";

/**
 * A registered action.
 *
 * Registration is the mechanism that makes "per-action authorization" real:
 * the chokepoint looks the action up here, and an action that is not here
 * cannot be performed at all.
 */
export interface ActionDescriptor {
  /** Stable machine name, e.g. `contact.send_letter`. */
  readonly name: string;
  readonly risk: RiskTier;
  readonly humanInvolvement: HumanInvolvement;
  /** One sentence an approver can read to understand what they are allowing. */
  readonly description: string;
  /**
   * Whether the effect can be undone. Irreversible actions must declare a
   * compensating action in the workflow definition and require an approval
   * gate before them.
   */
  readonly reversible: boolean;
  /** Roles permitted to perform it. Empty means no human role may. */
  readonly allowedRoles: readonly string[];
  /**
   * Operating modes in which the action may produce its effect.
   *
   * `shadow` is absent from almost every entry: the whole point of shadow mode
   * is that the agent proposes and nothing lands.
   */
  readonly allowedModes: readonly OperatingMode[];
  /** Requires a fresh re-authentication, not merely a valid session. */
  readonly requiresStepUp: boolean;
  /** Number of distinct approvers required, when approval applies. */
  readonly approvalsRequired: number;
  /** Ties the action to an integration so the integration kill switch reaches it. */
  readonly integration?: string | undefined;
}

/** What the caller wants to do, at the moment it wants to do it. */
export interface ActionRequest {
  readonly action: string;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  /** Opaque references describing the target. Never owner personal data. */
  readonly subject?: Readonly<Record<string, string>> | undefined;
  /**
   * Digest of the exact proposal this call would carry out.
   *
   * For an action requiring approval, the approval is bound to this digest, so
   * a proposal cannot be altered between approval and execution.
   */
  readonly proposalDigest?: Digest | undefined;
  /** Estimated spend, checked against the remaining ceiling before proceeding. */
  readonly estimatedCostUsd?: number | undefined;
  /** Identifier of a granted approval, when the caller believes it holds one. */
  readonly approvalId?: Id<"approval"> | undefined;
  /** Workflow this action belongs to, so the per-workflow switch reaches it. */
  readonly workflowName?: string | undefined;
  /** Role acting, so the per-role switch reaches it. */
  readonly roleId?: Id<"role"> | undefined;
  /** Seconds since the actor last re-authenticated, for step-up checks. */
  readonly secondsSinceAuthentication?: number | undefined;
  /** Data scopes the actor is entitled to; checked against `requiredScopes`. */
  readonly requiredScopes?: readonly string[] | undefined;
}

export interface AuthorizationGrant {
  readonly action: string;
  readonly descriptor: ActionDescriptor;
  /** Set when the grant consumed an approval; that approval is now spent. */
  readonly consumedApprovalId?: Id<"approval"> | undefined;
  readonly grantedAt: IsoTimestamp;
}

export type ApprovalStatus = "pending" | "granted" | "rejected" | "expired" | "consumed";

/**
 * A parked high-consequence action awaiting human decision.
 *
 * The approval is bound to `proposalDigest`. Granting approves *that* proposal
 * and no other, which is what stops a proposal being swapped after sign-off.
 */
export interface ApprovalRequest {
  readonly id: Id<"approval">;
  readonly action: string;
  readonly status: ApprovalStatus;
  readonly proposalDigest: Digest;
  /** Human-readable summary of what is being authorised. Shown to the approver. */
  readonly summary: string;
  readonly requestedBy: ActorRef;
  readonly requestedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly subject: Readonly<Record<string, string>>;
  /** Distinct approvals needed before the action may proceed (the N of N-of-M). */
  readonly approvalsRequired: number;
  /** Roles eligible to approve (the M of N-of-M). */
  readonly eligibleRoles: readonly string[];
  readonly decisions: readonly ApprovalDecision[];
  /** Set once the grant has been spent. Approvals are single-use. */
  readonly consumedAt?: IsoTimestamp | undefined;
  readonly consumedByRunId?: Id<"run"> | undefined;
}

export interface ApprovalDecision {
  readonly actor: ActorRef;
  readonly decision: "granted" | "rejected";
  readonly decidedAt: IsoTimestamp;
  readonly note?: string | undefined;
  /** Whether the approver had re-authenticated recently enough. */
  readonly steppedUp: boolean;
}

export type ContainmentScope = "global" | "workflow" | "role" | "integration";

/**
 * An operator's stop button.
 *
 * Reachable in seconds without a deploy, and checked at consumption — an
 * in-flight run re-checks containment before each step, so engaging a switch
 * stops work already running, not merely work not yet started.
 */
export interface ContainmentSwitch {
  readonly scope: ContainmentScope;
  /** The workflow name, role id, or integration name. Empty for `global`. */
  readonly target: string;
  readonly engaged: boolean;
  readonly engagedBy?: string | undefined;
  readonly engagedAt?: IsoTimestamp | undefined;
  readonly reason?: string | undefined;
}

export interface CeilingUsage {
  readonly runSpendUsd: number;
  readonly dailySpendUsd: number;
  readonly runElapsedMs: number;
  readonly modelCallsInWindow: number;
}

export interface CeilingLimits {
  readonly runSpendUsd: number;
  readonly dailySpendUsd: number;
  readonly runWallClockMs: number;
  readonly modelCallsPerMinute: number;
}
