import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type { RiskTier } from "../guard/types.js";

/**
 * Governance for agents MVW already runs elsewhere.
 *
 * MVW's teams and vendors are building agents inside their CRM, inside their
 * cloud provider's agent service, inside purchased products. Each is an
 * unsupervised actor touching owner data and potentially taking regulated
 * actions, and "who authorised that, and where is the record?" is a question
 * being asked now — not after the first workflow ships.
 *
 * The central distinction, which shapes every type in this file: **an agent
 * that runs elsewhere cannot be orchestrated here, but it can be fully governed
 * and accounted for here.** So there is no execution model, no scheduler, and
 * no state machine for someone else's agent. There is an admission chain it
 * must pass, a record of everything it did, and — where it wants the platform
 * to take an action on its behalf — a governed path with a human in it.
 *
 * Everything an external agent does lands in the same operating record and the
 * same audit chain as native work, under a principal marked external. One
 * record, one queue, one report. A parallel system for external agents would
 * recreate exactly the blind spot this exists to close.
 */

export type ExternalAgentId = Id<"externalAgent">;

/** Where an external agent actually runs. Free text: we do not control it. */
export type HostPlatform = string;

export type BudgetPeriod = "monthly" | "lifetime";

/**
 * A tool an agent is permitted to call, with the operator's risk rating.
 *
 * `operatorRisk` **floors** whatever the calling agent declares. External tool
 * names are arbitrary strings chosen by whoever built the agent, so an agent
 * calling `issue_refund` may declare it `routine` — through carelessness or
 * otherwise. The registry decides how risky a tool is; the agent's declaration
 * can only ever raise the tier, never lower it.
 */
export interface ToolGrant {
  readonly tool: string;
  readonly operatorRisk?: RiskTier | undefined;
  readonly note?: string | undefined;
}

export type AgentStatus = "active" | "contained" | "revoked";

/**
 * Enrollment states that are the end of the story.
 *
 * `contained` is deliberately not one of them: containment is a pause an
 * operator can release, and modelling it as terminal would make release
 * impossible. Revocation is the state `EnrollmentService.revoke` describes —
 * "there is no release from it — bringing the agent back is a fresh
 * enrollment" — and the store is where that has to hold, because the service is
 * not the only writer that reaches it.
 */
export const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = ["revoked"];

export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return TERMINAL_AGENT_STATUSES.includes(status);
}

/**
 * A registry entry for one external agent.
 *
 * Enrollment is the whole basis of admission: an unenrolled caller is refused.
 * There is no anonymous access and no default-allow.
 */
export interface EnrolledAgent {
  readonly id: ExternalAgentId;
  /** Stable, operator-chosen name. Unique. */
  readonly name: string;
  /** The person accountable for this agent. Never a shared mailbox. */
  readonly owner: string;
  readonly department: string;
  readonly hostPlatform: HostPlatform;
  /** What the agent is for, in the operator's words. Shown to approvers. */
  readonly purpose: string;

  readonly allowedTools: readonly ToolGrant[];
  /** The highest risk tier this agent may reach, whatever it declares. */
  readonly riskCeiling: RiskTier;
  readonly spendCeilingUsd: number;
  readonly budgetPeriod: BudgetPeriod;
  readonly wallClockCeilingMs: number;
  /** Data scopes, matching the `scope:` convention the chokepoint reads. */
  readonly dataScopes: readonly string[];

  readonly expiresAt: IsoTimestamp;
  readonly status: AgentStatus;
  /** Set when contained or revoked. Shown in the roster and the detail view. */
  readonly statusReason?: string | undefined;
  readonly statusChangedAt?: IsoTimestamp | undefined;
  readonly statusChangedBy?: string | undefined;

  readonly enrolledBy: string;
  readonly enrolledAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly lastSeenAt?: IsoTimestamp | undefined;
}

/**
 * The fields a re-enrollment may change.
 *
 * Deliberately narrow. Re-enrolling updates ceilings and metadata; it never
 * resets a spend meter and never lifts a containment. Both of those would make
 * "re-enroll" the way around a limit, which is precisely how an enrollment
 * system stops meaning anything.
 */
export interface EnrollmentUpdate {
  readonly owner?: string;
  readonly department?: string;
  readonly hostPlatform?: HostPlatform;
  readonly purpose?: string;
  readonly allowedTools?: readonly ToolGrant[];
  readonly riskCeiling?: RiskTier;
  readonly spendCeilingUsd?: number;
  readonly budgetPeriod?: BudgetPeriod;
  readonly wallClockCeilingMs?: number;
  readonly dataScopes?: readonly string[];
  readonly expiresAt?: IsoTimestamp;
}

/** Spend against a ceiling, for one budget period. */
export interface SpendMeter {
  readonly agentId: ExternalAgentId;
  /** `lifetime`, or `YYYY-MM` for a monthly budget. */
  readonly periodKey: string;
  readonly spentUsd: number;
  readonly updatedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export const CREDENTIAL_KINDS = ["bearer", "jwt", "hmac", "envelope"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/**
 * Credential kinds that prove possession of a key rather than of a string.
 *
 * The strong-credential switch refuses plain bearer authentication for any
 * agent holding one of these. It must cover **every** strong kind: a switch
 * that names two of the three leaves the third as a silent downgrade path.
 */
export const STRONG_CREDENTIAL_KINDS: readonly CredentialKind[] = ["jwt", "hmac", "envelope"];

export function isStrongCredentialKind(kind: CredentialKind): boolean {
  return STRONG_CREDENTIAL_KINDS.includes(kind);
}

/**
 * A credential record.
 *
 * **No credential value is ever stored.** A bearer token is stored as a hash,
 * so a leaked registry backup authenticates nothing. An HMAC secret is stored
 * as a *reference* resolved from a secret manager by name at verify time. A
 * JWT is verified against key material read from a local file. An envelope is
 * verified against a pinned public key, which is not a secret.
 */
export interface AgentCredential {
  readonly id: Id<"credential">;
  readonly agentId: ExternalAgentId;
  readonly kind: CredentialKind;
  /** Operator label, e.g. "crm production". */
  readonly label: string;

  /** `bearer` only: SHA-256 of the token. Never the token. */
  readonly tokenHash?: string | undefined;
  /** `jwt` only: expected issuer, audience, and the local JWKS file path. */
  readonly issuer?: string | undefined;
  readonly audience?: string | undefined;
  readonly jwksPath?: string | undefined;
  /** `hmac` only: the NAME to resolve from the secret manager. Never a value. */
  readonly secretRef?: string | undefined;
  /** `envelope` only: the pinned public key, PEM or JWK-thumbprint form. */
  readonly publicKey?: string | undefined;

  readonly createdBy: string;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp | undefined;
  readonly revokedAt?: IsoTimestamp | undefined;
  readonly revokedBy?: string | undefined;
  readonly revokedReason?: string | undefined;
  readonly lastUsedAt?: IsoTimestamp | undefined;
}

/** Returned exactly once, at mint time. The value is never retrievable again. */
export interface MintedCredential {
  readonly credential: AgentCredential;
  /** Present only for `bearer`. Shown once; never stored. */
  readonly token?: string | undefined;
}

/** What a caller presents. */
export type PresentedCredential =
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "jwt"; readonly token: string }
  | {
      readonly kind: "hmac";
      readonly agentId: string;
      readonly timestamp: string;
      readonly nonce: string;
      readonly signature: string;
      readonly bodyDigest: Digest;
    }
  | {
      readonly kind: "envelope";
      readonly agentId: string;
      readonly timestamp: string;
      readonly nonce: string;
      readonly signature: string;
      readonly bodyDigest: Digest;
    };

export interface VerifiedIdentity {
  readonly agentId: ExternalAgentId;
  readonly credentialId: Id<"credential">;
  readonly kind: CredentialKind;
  /** True when the presented credential proved possession of a key. */
  readonly strong: boolean;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export type AdmissionOperation =
  | "screen"
  | "report"
  | "run.start"
  | "run.heartbeat"
  | "run.finish"
  | "execute.read"
  | "execute.write"
  | "execute.commit";

/** What an external agent says it wants to do. */
export interface AdmissionRequest {
  readonly agentId: ExternalAgentId;
  readonly operation: AdmissionOperation;
  /** The external tool name, as the agent calls it. */
  readonly tool: string;
  /** The tier the agent declares. The operator's rating floors it. */
  readonly declaredRisk: RiskTier;
  /** Estimated spend for this unit of work. */
  readonly estimatedCostUsd?: number | undefined;
  /** Untrusted text accompanying the request. Bounded, then screened. */
  readonly untrustedInput?: string | undefined;
  readonly subject?: Readonly<Record<string, string>> | undefined;
  readonly requiredScopes?: readonly string[] | undefined;
  readonly correlationId?: string | undefined;
}

export type AdmissionOutcome = "allowed" | "approval_required" | "denied";

export interface AdmissionDecision {
  readonly outcome: AdmissionOutcome;
  /** The tier actually applied, after the operator floor. */
  readonly effectiveRisk: RiskTier;
  /** Set when `approval_required`. The agent polls this. */
  readonly approvalId?: Id<"approval"> | undefined;
  /** Set when `denied`. */
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
  /** Spend remaining in the current budget period, for the agent's own use. */
  readonly remainingBudgetUsd: number;
}

// ---------------------------------------------------------------------------
// Live runs
// ---------------------------------------------------------------------------

export type ExternalRunStatus =
  | "running"
  | "finished"
  | "failed"
  /** Stopped by containment, revocation, or an operator. */
  | "stopped"
  /** Stopped heartbeating and was reclaimed. */
  | "reclaimed";

export interface ExternalRun {
  readonly id: Id<"externalRun">;
  readonly agentId: ExternalAgentId;
  /** The run this external work is recorded against in the operating record. */
  readonly runId: Id<"run">;
  readonly goal: string;
  readonly status: ExternalRunStatus;
  readonly startedAt: IsoTimestamp;
  readonly lastHeartbeatAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp | undefined;
  readonly outcome?: string | undefined;
  readonly costUsd: number;
  readonly correlationId?: string | undefined;
}

/**
 * The reply to a heartbeat. **This is the kill switch.**
 *
 * An external agent cannot be reached from here, so containment cannot be
 * pushed to it — the only reliable moment to stop it is when it next asks. A
 * heartbeat that returns `stop` is the whole mechanism, which is why the reply
 * is a directive rather than an acknowledgement, and why a run that stops
 * heartbeating is reclaimed rather than assumed healthy.
 */
export interface HeartbeatReply {
  readonly directive: "continue" | "stop";
  readonly reason?: string | undefined;
  /** Seconds until the run is reclaimed if no further heartbeat arrives. */
  readonly reclaimAfterSeconds: number;
}

// ---------------------------------------------------------------------------
// Reported work
// ---------------------------------------------------------------------------

export interface ReportedStep {
  readonly name: string;
  readonly tool?: string | undefined;
  readonly startedAt: IsoTimestamp;
  readonly endedAt?: IsoTimestamp | undefined;
  readonly outcome: "succeeded" | "failed" | "skipped";
  readonly costUsd?: number | undefined;
  readonly detail?: Readonly<Record<string, string | number | boolean>> | undefined;
}

/** A completed episode of work, ingested onto the operating record. */
export interface RunReport {
  readonly agentId: ExternalAgentId;
  /**
   * Deduplication key supplied by the agent.
   *
   * Exactly-once ingestion depends on it: a retried report returns the original
   * record rather than double-counting spend against the ceiling.
   */
  readonly idempotencyKey: string;
  readonly goal: string;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp;
  readonly outcome: "succeeded" | "failed" | "denied";
  readonly summary?: string | undefined;
  readonly steps: readonly ReportedStep[];
  readonly costUsd: number;
  readonly subject?: Readonly<Record<string, string>> | undefined;
  readonly correlationId?: string | undefined;
}

export interface IngestedReport {
  readonly runId: Id<"run">;
  /** True when this report had already been ingested under the same key. */
  readonly duplicate: boolean;
  readonly costUsd: number;
}

/**
 * How one cost entry for external work came to be attributed, recorded on the
 * entry's `detail` under the key `attribution`.
 *
 * External work is the only work in this record whose costs arrive as two
 * separate claims — a total for the episode and a figure for each step — made
 * by a system this platform did not run. The two need not agree, and a ledger
 * that silently keeps one and drops the other produces a run-detail screen
 * whose column and header disagree with no way to tell which is wrong. So the
 * relationship between them is written down on every entry.
 *
 * Native work never needs this: the platform records its own costs against the
 * step that incurred them as it incurs them, so there is nothing to reconcile
 * and no entry carries an attribution.
 */
export const COST_ATTRIBUTION = {
  /** The agent's own figure for one step, recorded against that step. */
  reportedStep: "reported_step",
  /**
   * Reported total in excess of the step figures — real spend the agent
   * declined to attribute. Carried as its own entry rather than spread across
   * the steps, which would invent a precision the agent never reported.
   */
  unattributed: "unattributed_remainder",
  /**
   * The step figures summed to more than the reported total, so none of them
   * was promoted to the ledger. See `ReportIngestor.write`.
   */
  unreconciled: "unreconciled",
} as const;

// ---------------------------------------------------------------------------
// Governed execution
// ---------------------------------------------------------------------------

export type ParkedActionStatus =
  | "pending"
  | "approved"
  /**
   * The commit is in flight: the effect has been started and not yet recorded.
   *
   * A distinct state rather than a flag, because it is the only state from
   * which `indeterminate` is reachable. A worker that dies here leaves a parked
   * action whose effect may or may not have landed, and the sweeper can find it
   * precisely because it is marked.
   */
  | "committing"
  | "committed"
  | "rejected"
  | "voided"
  | "expired"
  /**
   * The worker died between deciding to act and recording the result.
   *
   * Never retried automatically. The effect may or may not have landed, and
   * only the system of record knows — so the operator is told to go and look
   * rather than being offered a button that might duplicate it.
   */
  | "indeterminate";

/** Terminal states. A parked action in one of these never changes again. */
export const TERMINAL_PARKED_STATUSES: readonly ParkedActionStatus[] = [
  "committed",
  "rejected",
  "voided",
  "indeterminate",
];

export function isTerminalParkedStatus(status: ParkedActionStatus): boolean {
  return TERMINAL_PARKED_STATUSES.includes(status);
}

/**
 * A write an external agent asked the platform to perform on its behalf.
 *
 * Two-phase and digest-bound. The first call parks this record carrying a
 * preview a human can read and a hash of the exact request; the agent re-sends
 * the byte-identical request to commit once a human approves. Any difference
 * between what was approved and what is committed voids the action.
 */
export interface ParkedAction {
  readonly id: Id<"parkedAction">;
  readonly agentId: ExternalAgentId;
  readonly integration: string;
  readonly operation: string;
  /**
   * Which path this action takes, decided when it was parked.
   *
   * Carried on the record rather than re-asserted at commit. The commit used to
   * assume `write`, which meant an operation the operator rated
   * high-consequence but registered as a read was parked, approved by a human,
   * and then refused at the last step for a mode mismatch — the approval spent
   * on something that could never happen.
   */
  readonly mode: "read" | "write";
  /** Digest of the canonical request. The approval binds to this. */
  readonly requestDigest: Digest;
  /** Human-readable rendering of what will happen. Shown to the approver. */
  readonly preview: readonly { readonly label: string; readonly value: string }[];
  readonly approvalId?: Id<"approval"> | undefined;
  readonly status: ParkedActionStatus;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly committedAt?: IsoTimestamp | undefined;
  /**
   * When the commit went in flight, which is not when it was parked.
   *
   * The interval the stale-commit sweeper is trying to measure is "how long has
   * this been running", and `createdAt` answers "how long ago was a human
   * asked" — normally hours earlier. Measuring the wrong one declares every
   * live commit abandoned on the first sweep.
   */
  readonly committingAt?: IsoTimestamp | undefined;
  /** The outcome of the committed action, replayed to a duplicate commit. */
  readonly resultDigest?: Digest | undefined;
  readonly resultSummary?: string | undefined;
  readonly voidReason?: string | undefined;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
}

export interface ExecuteRequest {
  readonly agentId: ExternalAgentId;
  readonly integration: string;
  readonly operation: string;
  /** `read` runs immediately; `write` is two-phase. */
  readonly mode: "read" | "write";
  /** The request body, canonicalised for digesting. */
  readonly request: Record<string, unknown>;
  /** Present on a commit: the parked action being committed. */
  readonly parkedActionId?: Id<"parkedAction"> | undefined;
  readonly correlationId?: string | undefined;
}

export type ExecuteOutcome =
  | { readonly kind: "completed"; readonly result: unknown; readonly runId: Id<"run"> }
  | {
      readonly kind: "approval_required";
      readonly parkedActionId: Id<"parkedAction">;
      readonly approvalId: Id<"approval">;
      readonly preview: ParkedAction["preview"];
    }
  | {
      readonly kind: "already_done";
      readonly parkedActionId: Id<"parkedAction">;
      readonly resultSummary?: string | undefined;
    }
  | {
      readonly kind: "indeterminate";
      readonly parkedActionId: Id<"parkedAction">;
      readonly message: string;
    };

// ---------------------------------------------------------------------------
// Rate limiting and misbehaviour
// ---------------------------------------------------------------------------

export interface RateLimitPolicy {
  /** Requests allowed per operation, per agent, in the window. */
  readonly perOperationPerMinute: number;
  /** Denials inside the window that trigger automatic containment. */
  readonly denialsBeforeContainment: number;
  readonly denialWindowMs: number;
}

/**
 * Whether a denial counts toward automatic containment.
 *
 * Misbehaviour counts. Our own infrastructure failing does not: containing an
 * agent because our database was briefly unreachable punishes a well-behaved
 * team for our outage, and teaches them the platform is unreliable rather than
 * strict.
 */
export type DenialClass = "misbehaviour" | "infrastructure";
