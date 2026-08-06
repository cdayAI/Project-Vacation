import type { Id } from "../kernel/ids.js";
import type {
  AgentCredential,
  DenialClass,
  EnrolledAgent,
  EnrollmentUpdate,
  ExternalAgentId,
  ExternalRun,
  ExternalRunStatus,
  ParkedAction,
  ParkedActionStatus,
  SpendMeter,
} from "./types.js";

/**
 * Persistence ports for the external-agent plane.
 *
 * Several methods here look like they could be composed by the caller out of a
 * read and a write. They cannot, and the comments say why on each one. This
 * service runs as multiple workers, and every one of these operations is a race
 * that a read-then-write loses: a replayed request against a second worker, two
 * commits of the same parked action, two agents claiming the last seat.
 *
 * The rule throughout: **if forgetting is possible, forgetting must only ever
 * refuse.** A bounded ledger that silently permits what it has evicted is worse
 * than no ledger, because it looks like protection.
 */

export interface EnrollmentStore {
  createAgent(agent: EnrolledAgent): Promise<EnrolledAgent>;
  getAgent(id: ExternalAgentId): Promise<EnrolledAgent | null>;
  getAgentByName(name: string): Promise<EnrolledAgent | null>;
  listAgents(filter?: {
    readonly status?: readonly EnrolledAgent["status"][];
    readonly department?: string;
    readonly limit?: number;
    readonly offset?: number;
  }): Promise<readonly EnrolledAgent[]>;
  countAgents(): Promise<number>;

  /**
   * Apply a re-enrollment.
   *
   * Must not touch spend meters and must not change status. Re-enrolling is how
   * an operator adjusts ceilings; if it also reset the meter or lifted a
   * containment it would become the documented way around both.
   */
  updateAgent(id: ExternalAgentId, update: EnrollmentUpdate, at: string): Promise<EnrolledAgent>;

  /**
   * Change status, conditional on the status the caller last saw.
   *
   * A containment decided from a stale read must not clobber a revocation
   * another process has already applied.
   */
  setAgentStatus(input: {
    readonly id: ExternalAgentId;
    readonly expectedStatus: EnrolledAgent["status"];
    readonly status: EnrolledAgent["status"];
    readonly reason: string;
    readonly by: string;
    readonly at: string;
  }): Promise<EnrolledAgent | null>;

  touchLastSeen(id: ExternalAgentId, at: string): Promise<void>;

  /**
   * Claim one seat against the cap, atomically.
   *
   * Returns false when the cap is reached. Counting rows and then inserting
   * lets two concurrent enrollments both see `count < cap` and both succeed,
   * which makes the commercial term unenforceable at exactly the moment it
   * matters.
   */
  claimSeat(cap: number): Promise<boolean>;
  releaseSeat(): Promise<void>;
}

export interface SpendStore {
  /**
   * Add to the meter and return the new total, atomically.
   *
   * Read-modify-write loses concurrent reports, and every lost report is spend
   * that happened but does not count against the ceiling.
   */
  addSpend(
    agentId: ExternalAgentId,
    periodKey: string,
    amountUsd: number,
    at: string,
  ): Promise<number>;
  getMeter(agentId: ExternalAgentId, periodKey: string): Promise<SpendMeter | null>;
  listMeters(agentId: ExternalAgentId): Promise<readonly SpendMeter[]>;
}

export interface CredentialStore {
  createCredential(credential: AgentCredential): Promise<AgentCredential>;
  getCredential(id: Id<"credential">): Promise<AgentCredential | null>;
  listCredentials(agentId: ExternalAgentId): Promise<readonly AgentCredential[]>;
  /** Look up by token hash. The token itself is never stored or queried. */
  findByTokenHash(tokenHash: string): Promise<AgentCredential | null>;
  revokeCredential(
    id: Id<"credential">,
    at: string,
    by: string,
    reason: string,
  ): Promise<AgentCredential | null>;
  touchCredentialUsed(id: Id<"credential">, at: string): Promise<void>;
  /** True when the agent holds any unrevoked, unexpired strong credential. */
  hasStrongCredential(agentId: ExternalAgentId, now: string): Promise<boolean>;
}

/**
 * Durable, per-agent single-use claims for request nonces.
 *
 * Two properties, both learned the hard way:
 *
 * **Durable and shared.** An in-memory cache lets a captured request replay
 * successfully against a different worker, which is no protection at all in
 * any deployment that has ever been scaled out.
 *
 * **Bounded per agent, never globally.** A global bound means two busy agents
 * can evict everyone else's claims and lock them out — a denial of service one
 * tenant inflicts on another by being ordinary.
 */
export interface NonceStore {
  /**
   * Claim a nonce for an agent. Returns false if it was already claimed.
   *
   * Must be atomic: two workers presented with the same replayed request must
   * not both see it as unclaimed.
   */
  claimNonce(agentId: ExternalAgentId, nonce: string, expiresAt: string): Promise<boolean>;
  /** Drop claims past their expiry. Called by the sweeper. */
  purgeExpiredNonces(now: string): Promise<number>;
  countNonces(agentId: ExternalAgentId): Promise<number>;
}

/**
 * One-shot ledger for consumed approvals.
 *
 * The subtle part is the floor. A bounded ledger must remember the highest id
 * it ever evicted and refuse anything at or below it, because otherwise an old
 * approval becomes reusable the moment it ages out — the protection quietly
 * expires instead of the approval.
 */
export interface UsedApprovalLedger {
  /** Record an approval as consumed. Returns false if it already was. */
  claimApproval(approvalId: Id<"approval">, at: string): Promise<boolean>;
  /** True when this approval was consumed, or is at or below the evicted floor. */
  isConsumed(approvalId: Id<"approval">): Promise<boolean>;
  /** Evict old entries, raising the floor. Returns the new floor. */
  evictBefore(cutoff: string): Promise<string | null>;
}

export interface ParkedActionStore {
  createParkedAction(action: ParkedAction): Promise<ParkedAction>;
  getParkedAction(id: Id<"parkedAction">): Promise<ParkedAction | null>;
  listParkedActions(filter?: {
    readonly agentId?: ExternalAgentId;
    readonly status?: readonly ParkedActionStatus[];
    readonly limit?: number;
  }): Promise<readonly ParkedAction[]>;

  /**
   * Attach the approval this action is waiting on.
   *
   * Separate from creation because the record must exist — holding the request
   * digest — before the approval is raised against that digest. If the approval
   * cannot be created, the caller voids the record rather than leaving it
   * pending with nothing to consume, which would be uncommittable and invisible.
   */
  bindApproval(
    id: Id<"parkedAction">,
    approvalId: Id<"approval">,
    at: string,
  ): Promise<ParkedAction | null>;

  /**
   * Move a parked action to a new status, conditional on its current one.
   *
   * Returns null when the current status is not `expectedStatus`, which is how
   * a duplicate commit is detected. Deciding from a stale read and writing
   * unconditionally would let a second commit overwrite the first one's result.
   */
  transitionParkedAction(input: {
    readonly id: Id<"parkedAction">;
    readonly expectedStatus: ParkedActionStatus;
    readonly status: ParkedActionStatus;
    readonly at: string;
    readonly resultDigest?: string;
    readonly resultSummary?: string;
    readonly voidReason?: string;
  }): Promise<ParkedAction | null>;

  /** Mark pending actions past their expiry. Terminal states are untouched. */
  expireParkedActions(now: string): Promise<readonly ParkedAction[]>;
}

export interface ExternalRunStore {
  createExternalRun(run: ExternalRun): Promise<ExternalRun>;
  getExternalRun(id: Id<"externalRun">): Promise<ExternalRun | null>;
  listExternalRuns(filter?: {
    readonly agentId?: ExternalAgentId;
    readonly status?: readonly ExternalRunStatus[];
    readonly limit?: number;
  }): Promise<readonly ExternalRun[]>;
  heartbeat(id: Id<"externalRun">, at: string): Promise<ExternalRun | null>;
  finishExternalRun(input: {
    readonly id: Id<"externalRun">;
    readonly status: ExternalRunStatus;
    readonly at: string;
    readonly outcome?: string;
    readonly costUsd?: number;
  }): Promise<ExternalRun | null>;
  /** Runs whose last heartbeat is older than the cutoff. */
  findStaleRuns(cutoff: string, limit: number): Promise<readonly ExternalRun[]>;

  /**
   * Record an ingested report under its idempotency key.
   *
   * Returns the previously recorded run id when the key has been seen, which is
   * what makes ingestion exactly-once. Without it a retried report — and agents
   * retry, that is the point of a report endpoint — double-counts spend.
   */
  claimReport(
    agentId: ExternalAgentId,
    idempotencyKey: string,
    runId: Id<"run">,
    at: string,
  ): Promise<{ readonly claimed: boolean; readonly existingRunId: Id<"run"> }>;
}

export interface RateLimitStore {
  /**
   * Count this request and return how many are in the window.
   *
   * Atomic, and per agent and operation. Returning the count rather than a
   * boolean lets the caller decide, and lets the console show how close an
   * agent is running to its limit.
   */
  recordRequest(
    agentId: ExternalAgentId,
    operation: string,
    at: string,
    windowMs: number,
  ): Promise<number>;

  /** Record a denial that counts toward containment, and return the window count. */
  recordDenial(
    agentId: ExternalAgentId,
    at: string,
    windowMs: number,
    denialClass: DenialClass,
  ): Promise<number>;

  clearDenials(agentId: ExternalAgentId): Promise<void>;
}
