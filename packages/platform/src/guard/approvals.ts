import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import { digestsEqual, isDigest, type Digest } from "../kernel/hash.js";
import type { IdGenerator, Id } from "../kernel/ids.js";
import type { ActorRef } from "../record/types.js";
import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { ApprovalStore } from "./port.js";
import type { ApprovalDecision, ApprovalRequest, ApprovalStatus } from "./types.js";

/**
 * Human approvals with dual control.
 *
 * The properties this class exists to guarantee, and the attack each one
 * closes:
 *
 *   Digest binding      An approval is bound to a digest of exactly what was
 *                       proposed. Approving authorises *that* proposal. Swap
 *                       the proposal after sign-off and consumption fails.
 *
 *   Segregation of duties
 *                       A requester cannot approve their own request. Without
 *                       this, "requires approval" means "requires a second
 *                       click from the same person".
 *
 *   N-of-M              N distinct approvers drawn from M eligible roles. The
 *                       store rejects a second decision from the same actor
 *                       atomically, so one person cannot satisfy a 2-of-M
 *                       requirement by racing two requests.
 *
 *   Single use          Consumption is an atomic compare-and-set in the store.
 *                       Two concurrent executions holding the same approval
 *                       id: exactly one wins, the other is denied as a replay.
 *
 *   Expiry              An approval granted last month does not authorise an
 *                       action today. Expiry is checked on grant and again on
 *                       consumption, because time passes in between.
 */
/**
 * The failure signature a rejection is filed under.
 *
 * Derived from the action name so it stays inside the controlled vocabulary the
 * harvester enforces — dotted lower_snake_case — and so every rejection of the
 * same action clusters together. A free-text signature would produce one
 * cluster per approver and nothing would ever recur.
 *
 * Here rather than beside either caller because there are two of them now: the
 * HTTP decision route and the command line's. Two copies of this would cluster
 * the same disagreement under two names depending on which surface the
 * approver happened to use, and the loop would never see the frequency.
 */
export function rejectionSignature(action: string): string {
  const normalised = action.replace(/[^a-z0-9_.]/gi, "_").toLowerCase();
  return `approval.rejected.${normalised}`.slice(0, 96);
}

export class ApprovalService {
  constructor(
    private readonly store: ApprovalStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly audit: AuditLog,
    private readonly defaultTtlMs = 24 * 60 * 60 * 1000,
  ) {}

  /** Park an action for human decision. */
  async request(input: {
    readonly action: string;
    readonly proposalDigest: Digest;
    readonly summary: string;
    readonly requestedBy: ActorRef;
    readonly approvalsRequired: number;
    readonly eligibleRoles: readonly string[];
    readonly runId?: Id<"run">;
    readonly correlationId?: string;
    readonly subject?: Readonly<Record<string, string>>;
    readonly ttlMs?: number;
  }): Promise<ApprovalRequest> {
    if (!isDigest(input.proposalDigest)) {
      throw new DeniedError(
        "approval.digest_mismatch",
        "An approval must be bound to a sha256 digest of the proposal. Without a digest there is nothing stopping the proposal from changing after approval.",
        { action: input.action },
      );
    }
    if (input.approvalsRequired < 1) {
      throw new DeniedError(
        "approval.insufficient_approvers",
        `Action "${input.action}" requested approval but requires ${input.approvalsRequired} approvers.`,
        { action: input.action },
      );
    }
    if (input.eligibleRoles.length === 0) {
      throw new DeniedError(
        "approval.insufficient_approvers",
        `Action "${input.action}" has no eligible approver roles, so no one could ever approve it.`,
        { action: input.action },
      );
    }

    const now = this.clock.now();
    const request: ApprovalRequest = {
      id: this.ids.next("approval"),
      action: input.action,
      status: "pending",
      proposalDigest: input.proposalDigest,
      summary: input.summary,
      requestedBy: input.requestedBy,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (input.ttlMs ?? this.defaultTtlMs)).toISOString(),
      runId: input.runId,
      correlationId: input.correlationId,
      subject: input.subject ?? {},
      approvalsRequired: input.approvalsRequired,
      eligibleRoles: [...input.eligibleRoles],
      decisions: [],
    };

    const created = await this.store.createApproval(request);

    await this.audit.record(
      auditDecision({
        eventType: "approval.requested",
        actorId: input.requestedBy.actorId,
        actorKind: input.requestedBy.kind,
        actorRoles: input.requestedBy.roles,
        runId: input.runId,
        correlationId: input.correlationId,
        subject: { ...request.subject, approvalId: created.id, action: input.action },
        inputDigests: { proposal: input.proposalDigest },
        decision: {
          approvalsRequired: input.approvalsRequired,
          eligibleRoles: input.eligibleRoles.join(","),
          expiresAt: request.expiresAt,
        },
      }),
    );

    return created;
  }

  /**
   * Record one approver's decision.
   *
   * @throws {DeniedError} on self-approval, ineligibility, a repeat decision,
   *   expiry, or a missing step-up.
   */
  async decide(input: {
    readonly approvalId: Id<"approval">;
    readonly actor: ActorRef;
    readonly decision: "granted" | "rejected";
    readonly note?: string;
    readonly secondsSinceAuthentication?: number;
    readonly stepUpMaxAgeSeconds?: number;
    readonly requiresStepUp?: boolean;
  }): Promise<ApprovalRequest> {
    const request = await this.store.getApproval(input.approvalId);
    if (!request) {
      throw new DeniedError("approval.required", `Approval ${input.approvalId} does not exist.`, {
        approvalId: input.approvalId,
      });
    }

    if (request.status !== "pending") {
      throw new DeniedError(
        request.status === "expired" ? "approval.expired" : "approval.already_used",
        `Approval ${request.id} is ${request.status} and can no longer be decided.`,
        { approvalId: request.id, status: request.status },
      );
    }

    if (this.clock.nowIso() > request.expiresAt) {
      await this.store.expireApprovals(this.clock.nowIso());
      throw new DeniedError(
        "approval.expired",
        `Approval ${request.id} expired at ${request.expiresAt}.`,
        { approvalId: request.id, expiresAt: request.expiresAt },
      );
    }

    // Segregation of duties. Checked here rather than in the store because it
    // is a policy question, not a storage one.
    if (input.actor.actorId === request.requestedBy.actorId) {
      throw new DeniedError(
        "approval.self_approval",
        `${input.actor.actorId} requested this action and cannot also approve it.`,
        { approvalId: request.id, actorId: input.actor.actorId },
      );
    }

    const eligible = input.actor.roles.some((role) => request.eligibleRoles.includes(role));
    if (!eligible) {
      throw new DeniedError(
        "approval.insufficient_approvers",
        `${input.actor.actorId} holds none of the roles eligible to approve "${request.action}" (${request.eligibleRoles.join(", ")}).`,
        { approvalId: request.id, actorId: input.actor.actorId },
      );
    }

    const steppedUp =
      input.secondsSinceAuthentication !== undefined &&
      input.stepUpMaxAgeSeconds !== undefined &&
      input.secondsSinceAuthentication <= input.stepUpMaxAgeSeconds;

    // Step-up gates granting, not rejecting.
    //
    // A rejection is the safe direction — it stops the action — and requiring
    // re-authentication to stop something has the shape of a control while
    // acting as an obstacle: the work stays pending, which is the outcome the
    // requirement was trying to prevent. Whoever is refusing is still
    // authenticated and still role-checked above; what they are not being asked
    // for is a second proof in order to say no.
    if (input.decision === "granted" && input.requiresStepUp && !steppedUp) {
      throw new DeniedError(
        "authorization.step_up_required",
        `Approving "${request.action}" requires re-authentication within the last ${input.stepUpMaxAgeSeconds ?? 0}s, and this platform has not observed one. A high-consequence approval is refused rather than recorded as if a re-authentication happened.`,
        { approvalId: request.id, actorId: input.actor.actorId },
      );
    }

    const record: ApprovalDecision = {
      actor: input.actor,
      decision: input.decision,
      decidedAt: this.clock.nowIso(),
      note: input.note,
      steppedUp,
    };

    // One rejection is decisive; grants accumulate until the threshold is met.
    const grantsAfter =
      request.decisions.filter((entry) => entry.decision === "granted").length +
      (input.decision === "granted" ? 1 : 0);
    const nextStatus: ApprovalStatus =
      input.decision === "rejected"
        ? "rejected"
        : grantsAfter >= request.approvalsRequired
          ? "granted"
          : "pending";

    // The store enforces "one decision per actor" atomically. A duplicate
    // arriving concurrently is rejected there, not here.
    const updated = await this.store.recordApprovalDecision(request.id, record, nextStatus);

    await this.audit.record(
      auditDecision({
        eventType: input.decision === "granted" ? "approval.granted" : "approval.rejected",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        runId: request.runId,
        correlationId: request.correlationId,
        subject: { ...request.subject, approvalId: request.id, action: request.action },
        inputDigests: { proposal: request.proposalDigest },
        decision: {
          decision: input.decision,
          steppedUp,
          grants: grantsAfter,
          required: request.approvalsRequired,
          status: updated.status,
          ...(input.note ? { note: input.note.slice(0, 512) } : {}),
        },
      }),
    );

    return updated;
  }

  /**
   * Spend a granted approval on exactly the proposal it was bound to.
   *
   * @throws {DeniedError} if the approval is missing, not granted, expired,
   *   already spent, or bound to a different proposal.
   */
  async consume(input: {
    readonly approvalId: Id<"approval">;
    readonly expectedProposalDigest: Digest;
    readonly runId?: Id<"run">;
    readonly actor: ActorRef;
    /**
     * The action this approval is about to be spent on.
     *
     * Optional only because not every caller has a registered action name to
     * check against. When supplied it is verified *here*, before the
     * compare-and-set, because consuming is destructive: an approval presented
     * against the wrong action must be refused without costing the approver
     * their decision.
     */
    readonly expectedAction?: string;
  }): Promise<ApprovalRequest> {
    const request = await this.store.getApproval(input.approvalId);
    if (!request) {
      throw new DeniedError("approval.required", `Approval ${input.approvalId} does not exist.`, {
        approvalId: input.approvalId,
      });
    }

    // Digest binding is checked before status, so a mismatched proposal is
    // reported as a mismatch even if the approval also happens to be spent.
    // That is the more useful diagnosis and the more serious finding.
    if (!digestsEqual(request.proposalDigest, input.expectedProposalDigest)) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Approval ${request.id} authorised a different proposal. What was approved is not what is about to be done.`,
        { approvalId: request.id, action: request.action },
      );
    }

    // A granted approval for a cheap action must not be redeemable against an
    // expensive one. A proposal digest is not a secret — it is on the approval
    // record the console renders and in `inputDigests.proposal` on every audit
    // entry about it — so a caller holding a digest can present it against a
    // different registered action. Refusing here rather than after consumption
    // is what stops that refusal from destroying the approval on its way past.
    if (input.expectedAction !== undefined && request.action !== input.expectedAction) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Approval ${request.id} was raised for "${request.action}", not "${input.expectedAction}".`,
        { approvalId: request.id, action: input.expectedAction },
      );
    }

    if (request.status === "consumed") {
      throw new DeniedError(
        "approval.already_used",
        `Approval ${request.id} has already been used. Approvals are single-use.`,
        { approvalId: request.id },
      );
    }
    if (request.status === "rejected") {
      throw new DeniedError("approval.required", `Approval ${request.id} was rejected.`, {
        approvalId: request.id,
      });
    }
    if (request.status === "pending") {
      throw new DeniedError(
        "approval.required",
        `Approval ${request.id} still needs ${request.approvalsRequired - request.decisions.filter((d) => d.decision === "granted").length} more approver(s).`,
        { approvalId: request.id },
      );
    }
    if (request.status === "expired" || this.clock.nowIso() > request.expiresAt) {
      throw new DeniedError(
        "approval.expired",
        `Approval ${request.id} expired at ${request.expiresAt}.`,
        { approvalId: request.id },
      );
    }

    // Atomic compare-and-set. Whichever concurrent caller loses gets null.
    const consumed = await this.store.consumeApproval(
      request.id,
      this.clock.nowIso(),
      input.runId,
    );
    if (!consumed) {
      throw new DeniedError(
        "approval.already_used",
        `Approval ${request.id} was consumed by another execution. Approvals are single-use.`,
        { approvalId: request.id },
      );
    }

    await this.audit.record(
      auditDecision({
        eventType: "approval.consumed",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        runId: input.runId,
        correlationId: request.correlationId,
        subject: { ...request.subject, approvalId: request.id, action: request.action },
        inputDigests: { proposal: request.proposalDigest },
        decision: { consumed: true },
      }),
    );

    return consumed;
  }

  get(id: Id<"approval">): Promise<ApprovalRequest | null> {
    return this.store.getApproval(id);
  }

  list(filter?: Parameters<ApprovalStore["listApprovals"]>[0]): Promise<readonly ApprovalRequest[]> {
    return this.store.listApprovals(filter);
  }

  /**
   * Sweep expired approvals.
   *
   * Called by the `approvals.expire` pass of the maintenance loop, which is
   * `pv worker`, and by nothing else. This used to say "the scheduler and the
   * CLI", at a time when there was neither a scheduler nor a CLI verb that
   * called it — so approvals never expired anywhere, and the sentence was the
   * reason nobody checked.
   */
  async expireDue(): Promise<readonly ApprovalRequest[]> {
    const expired = await this.store.expireApprovals(this.clock.nowIso());
    for (const request of expired) {
      await this.audit.record(
        auditDecision({
          eventType: "approval.expired",
          actorId: "system",
          actorKind: "system",
          runId: request.runId,
          subject: { approvalId: request.id, action: request.action },
          decision: { expiresAt: request.expiresAt },
        }),
      );
    }
    return expired;
  }
}
