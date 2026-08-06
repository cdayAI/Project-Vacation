import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { ApprovalService } from "../guard/approvals.js";
import type { ActionRegistry } from "../guard/registry.js";
import type { ApprovalRequest } from "../guard/types.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { RunStore } from "../record/port.js";
import type { ActorRef, OperatingMode, Run, RunStatus } from "../record/types.js";
import { TERMINAL_RUN_STATUSES } from "../record/types.js";
import type { RoleStore } from "../roles/port.js";
import { APPLY_ACTION } from "./actions.js";
import { assertOffered } from "./evaluate.js";
import type { ObservationHarvester } from "./harvest.js";
import type { ProposalStore } from "./port.js";
import { assertProposalIntact, freezeProposal } from "./propose.js";
import type {
  ArtifactContent,
  ArtifactState,
  BlastRadius,
  Proposal,
  ProposalDecision,
  ProposalEvaluation,
} from "./types.js";

/**
 * Stage five: approve.
 *
 * A human with authority decides, through the same `Authorizer` and
 * `ApprovalService` every other consequential action in this platform uses.
 * None of that machinery is reimplemented here: `improvement.apply` is
 * `high_consequence` in the action catalogue, so digest binding, segregation of
 * duties, single use, expiry, and step-up re-authentication all apply for free,
 * and the one thing this module adds is the packet the approver reads.
 *
 * That packet is the point. An approval that is a yes/no button on an opaque
 * change is a rubber stamp with an audit trail, which is worse than no gate at
 * all because it looks like one. So the reviewer gets:
 *
 *   the before and after   field by field, as a diff.
 *   the evaluation delta   what it measured before, what it measures now, which
 *                          cases improved, and the fact that nothing regressed.
 *   the blast radius       which roles, which workflows, how many runs — every
 *                          number counted from the operating record, not
 *                          estimated and not bucketed into a risk word.
 *
 * The approval digest covers the change and the evaluation, so neither can be
 * swapped after sign-off. It deliberately does **not** cover the blast radius:
 * that is a live measurement of a moving system, and binding a number that
 * changes every minute would make every approval unconsumable by the time
 * anybody clicked it. What the approver was shown is preserved on the decision
 * and in the audit entry instead, which is where a later reviewer would look
 * for it anyway.
 */

const DEFAULT_WINDOW_DAYS = 30;
const MAX_SAMPLE_RUNS = 5;
const MAX_NOTE_LENGTH = 512;

/** One field-level difference, for the diff an approver reads. */
export interface ArtifactChange {
  readonly field: string;
  readonly kind: "added" | "removed" | "changed";
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface ReviewPacket {
  readonly proposal: Proposal;
  readonly evaluation: ProposalEvaluation;
  readonly before: ArtifactState;
  readonly after: ArtifactState;
  readonly changes: readonly ArtifactChange[];
  readonly blastRadius: BlastRadius;
  /** The digest a decision on this packet is bound to. */
  readonly approvalDigest: Digest;
  /** The whole thing in a paragraph, for a console or a notification. */
  readonly summary: string;
}

export interface RequestApprovalInput {
  readonly proposalId: Id<"proposal">;
  readonly requestedBy: ActorRef;
  /** Roles eligible to approve. Defaults to the action descriptor's list. */
  readonly eligibleRoles?: readonly string[] | undefined;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly ttlMs?: number | undefined;
  readonly windowDays?: number | undefined;
}

export interface DecideInput {
  readonly proposalId: Id<"proposal">;
  readonly approvalId: Id<"approval">;
  readonly actor: ActorRef;
  readonly decision: "granted" | "rejected";
  readonly note?: string | undefined;
  /**
   * The operating-record run this review happened on.
   *
   * Required. A rejection becomes an observation in stage one, and an
   * observation with no run behind it is an anecdote — so the review itself is
   * work the platform records, like everything else it does.
   */
  readonly runId: Id<"run">;
  readonly mode: OperatingMode;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
  readonly windowDays?: number | undefined;
}

export interface DecisionOutcome {
  readonly proposal: Proposal;
  readonly approval: ApprovalRequest;
  /** False while an N-of-M approval is still short of its threshold. */
  readonly settled: boolean;
}

export interface ImprovementApprovalDependencies {
  readonly proposals: ProposalStore;
  readonly runs: RunStore;
  readonly roles: RoleStore;
  readonly approvals: ApprovalService;
  readonly actions: ActionRegistry;
  readonly harvester: ObservationHarvester;
  readonly audit: AuditLog;
  readonly clock: Clock;
  /** Seconds within which an approver must have re-authenticated. */
  readonly stepUpMaxAgeSeconds: number;
}

export class ImprovementApprovalService {
  constructor(private readonly deps: ImprovementApprovalDependencies) {}

  /**
   * Everything an approver needs, computed rather than asserted.
   *
   * @throws {DeniedError} `improvement.evaluation_regression` when the proposal
   *   was never measured or was withheld. A withheld proposal has no review
   *   packet because it is never put in front of anybody.
   */
  async reviewPacket(
    proposalId: Id<"proposal">,
    options: { readonly windowDays?: number | undefined } = {},
  ): Promise<ReviewPacket> {
    const proposal = await this.deps.proposals.requireProposal(proposalId);
    assertProposalIntact(proposal);
    const evaluation = assertOffered(proposal);
    const blastRadius = await this.blastRadius(proposal, options.windowDays);

    return {
      proposal: freezeProposal(proposal),
      evaluation,
      before: proposal.before,
      after: proposal.after,
      changes: diffArtifactContent(proposal.before.content, proposal.after.content),
      blastRadius,
      approvalDigest: approvalDigest(proposal),
      summary: summarise(proposal, evaluation, blastRadius),
    };
  }

  /**
   * Park the change for a human decision.
   *
   * @throws {DeniedError} `improvement.evaluation_regression` when the proposal
   *   has not earned a place in the queue.
   */
  async requestApproval(input: RequestApprovalInput): Promise<{
    readonly approval: ApprovalRequest;
    readonly packet: ReviewPacket;
  }> {
    const packet = await this.reviewPacket(input.proposalId, {
      windowDays: input.windowDays,
    });
    const descriptor = this.deps.actions.require(APPLY_ACTION);

    const approval = await this.deps.approvals.request({
      action: APPLY_ACTION,
      proposalDigest: packet.approvalDigest,
      summary: packet.summary,
      requestedBy: input.requestedBy,
      approvalsRequired: descriptor.approvalsRequired,
      eligibleRoles: input.eligibleRoles ?? descriptor.allowedRoles,
      runId: input.runId,
      correlationId: input.correlationId,
      subject: {
        proposalId: packet.proposal.id,
        roleId: packet.proposal.roleId,
        artifactKind: packet.proposal.target.kind,
        artifactId: packet.proposal.target.id,
      },
      ttlMs: input.ttlMs,
    });

    return { approval, packet };
  }

  /**
   * Record one approver's decision.
   *
   * The `ApprovalService` does the deciding — self-approval, eligibility, a
   * repeat decision from the same actor, expiry, and step-up are all its rules,
   * applied identically here and everywhere else. What this method adds is
   * moving the proposal to match, and turning a rejection into an observation
   * so that the reason a person said no becomes evidence the loop learns from.
   */
  async decide(input: DecideInput): Promise<DecisionOutcome> {
    const proposal = await this.deps.proposals.requireProposal(input.proposalId);
    assertProposalIntact(proposal);
    const evaluation = assertOffered(proposal);

    if (proposal.status !== "offered") {
      throw new DeniedError(
        "approval.already_used",
        `Proposal ${proposal.id} is ${proposal.status} and is no longer awaiting a decision.`,
        { proposalId: proposal.id, status: proposal.status },
      );
    }

    const descriptor = this.deps.actions.require(APPLY_ACTION);
    const note = (input.note ?? "").slice(0, MAX_NOTE_LENGTH);

    const approval = await this.deps.approvals.decide({
      approvalId: input.approvalId,
      actor: input.actor,
      decision: input.decision,
      note,
      secondsSinceAuthentication: input.secondsSinceAuthentication,
      stepUpMaxAgeSeconds: this.deps.stepUpMaxAgeSeconds,
      requiresStepUp: descriptor.requiresStepUp,
    });

    // Defence in depth. The chokepoint checks this again when the approval is
    // consumed, but catching it here means a decision recorded against the
    // wrong proposal never reaches the proposal's own record.
    if (approval.proposalDigest !== approvalDigest(proposal)) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Approval ${approval.id} was raised for a different change than proposal ${proposal.id} describes.`,
        { proposalId: proposal.id, approvalId: approval.id },
      );
    }

    // Still short of its threshold: an N-of-M approval that has one grant is
    // not a decision yet, and moving the proposal now would let the first
    // approver's click do the work of two.
    if (approval.status === "pending") {
      return { proposal: freezeProposal(proposal), approval, settled: false };
    }

    const blastRadius = await this.blastRadius(proposal, input.windowDays);
    const recorded: ProposalDecision = {
      approvalId: approval.id,
      decision: input.decision,
      decidedBy: input.actor,
      decidedAt: this.deps.clock.nowIso(),
      note,
      blastRadius,
    };

    const moved = await this.deps.proposals.transitionProposal({
      id: proposal.id,
      expectedStatus: "offered",
      nextStatus: input.decision === "granted" ? "approved" : "rejected",
      patch: { decision: recorded },
    });
    if (!moved) {
      throw new DeniedError(
        "record.unavailable",
        `Proposal ${proposal.id} was decided by someone else while this decision was in flight.`,
        { proposalId: proposal.id },
      );
    }

    await this.deps.audit.record(
      auditDecision({
        eventType:
          input.decision === "granted"
            ? "improvement.proposal_approved"
            : "improvement.proposal_rejected",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        runId: input.runId,
        correlationId: input.correlationId,
        subject: {
          proposalId: proposal.id,
          roleId: proposal.roleId,
          approvalId: approval.id,
          artifactKind: proposal.target.kind,
          artifactId: proposal.target.id,
        },
        inputDigests: {
          proposal: proposal.digest,
          approval: approval.proposalDigest,
          goldenSet: evaluation.goldenSetDigest,
        },
        decision: {
          decision: input.decision,
          delta: evaluation.delta,
          candidateAccuracy: evaluation.candidateAccuracy,
          affectedRoles: blastRadius.roleIds.length,
          affectedWorkflows: blastRadius.workflowKinds.length,
          runsInWindow: blastRadius.runCount,
          openRuns: blastRadius.openRunCount,
          ...(note ? { note } : {}),
          // Approval is not application. The change is still not live, and the
          // chain says so at the moment the decision is recorded.
          applied: false,
        },
      }),
    );

    if (input.decision === "rejected") {
      // A rejection is the single most informative thing a human does to this
      // loop: it is a person saying the machine's idea was wrong, with a
      // reason. Feeding it straight back in as an observation is what makes the
      // loop a loop rather than a funnel.
      await this.deps.harvester.rejectedProposal({
        runId: input.runId,
        signature: `improvement.rejected.${proposal.target.kind}`,
        note: note || `Proposal ${proposal.id} was rejected without a stated reason.`,
        observedBy: input.actor,
        mode: input.mode,
        roleId: proposal.roleId,
        roleVersion: proposal.roleVersion,
        before: proposal.before.digest,
        after: proposal.after.digest,
        subject: {
          proposalId: proposal.id,
          artifactKind: proposal.target.kind,
          artifactId: proposal.target.id,
        },
        correlationId: input.correlationId,
        secondsSinceAuthentication: input.secondsSinceAuthentication,
      });
    }

    return { proposal: freezeProposal(moved), approval, settled: true };
  }

  /**
   * What this change would reach, counted from the operating record.
   *
   * Every figure here is one an operator could reproduce with a query. The
   * affected roles are found by asking which promoted role definitions actually
   * reference the artifact — not by assuming it is only the one the proposal
   * names, which is wrong exactly when it matters: a prompt two roles share, or
   * a golden set three roles are measured against.
   */
  async blastRadius(proposal: Proposal, windowDays?: number): Promise<BlastRadius> {
    const days = windowDays ?? DEFAULT_WINDOW_DAYS;
    const since = new Date(this.deps.clock.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const roleIds = await this.affectedRoleIds(proposal);
    const roleNames: string[] = [];
    const workflowKinds = new Set<string>();
    const sampleRunIds: Id<"run">[] = [];
    let runCount = 0;
    let openRunCount = 0;

    const openStatuses = OPEN_RUN_STATUSES;

    for (const roleId of roleIds) {
      const role = await this.deps.roles.getRole(roleId);
      if (role) roleNames.push(role.name);

      runCount += await this.deps.runs.countRuns({ roleId, createdAfter: since });
      openRunCount += await this.deps.runs.countRuns({ roleId, status: openStatuses });

      const recent = await this.deps.runs.listRuns({ roleId, createdAfter: since, limit: 50 });
      for (const run of recent) {
        workflowKinds.add(run.kind);
        if (sampleRunIds.length < MAX_SAMPLE_RUNS) sampleRunIds.push(run.id);
      }
    }

    return {
      roleIds,
      roleNames: roleNames.sort(),
      workflowKinds: [...workflowKinds].sort(),
      windowDays: days,
      runCount,
      openRunCount,
      sampleRunIds,
      computedAt: this.deps.clock.nowIso(),
    };
  }

  /**
   * Every role this change reaches.
   *
   * A prompt binding reaches every role bound to the prompt it names — the one
   * it moves away from as well as the one it moves to, because a reviewer needs
   * to know who else is on the old binding. A golden-set change reaches every
   * role measured against that set.
   */
  private async affectedRoleIds(proposal: Proposal): Promise<readonly Id<"role">[]> {
    const affected = new Set<string>([proposal.roleId]);
    const roles = await this.deps.roles.listRoles();

    for (const role of roles) {
      const promoted = await this.deps.roles.promotedVersion(role.id);
      if (!promoted) continue;
      const definition = promoted.definition;

      if (proposal.target.kind === "evaluation_case") {
        if (definition.evaluationSetId === proposal.target.id) affected.add(role.id);
        continue;
      }

      if (proposal.target.kind === "prompt_binding") {
        const from = proposal.before.content["promptTemplateId"];
        const to = proposal.after.content["promptTemplateId"];
        if (definition.promptTemplateId === from || definition.promptTemplateId === to) {
          affected.add(role.id);
        }
      }
    }

    return [...affected].sort() as readonly Id<"role">[];
  }
}

/** Run statuses that mean the work is still in the air. */
const OPEN_RUN_STATUSES: readonly RunStatus[] = (
  ["pending", "running", "awaiting_human", "awaiting_approval"] as const
).filter((status) => !TERMINAL_RUN_STATUSES.includes(status));

/**
 * The digest an approver's decision is bound to.
 *
 * Covers the change *and* the evaluation. Binding only to the change would
 * leave the evidence swappable after sign-off: approve a revision on the
 * strength of a four-point gain, then apply it citing a different trial. Both
 * halves are what the approver was shown, so both are in the digest.
 *
 * @throws {DeniedError} `improvement.evaluation_regression` when the proposal
 *   has no offered evaluation. There is no digest for an unmeasured change,
 *   which means there is no approval to raise for one either.
 */
export function approvalDigest(proposal: Proposal): Digest {
  const evaluation = assertOffered(proposal);
  return digestValue({
    kind: "improvement.apply",
    proposalId: proposal.id,
    changeDigest: proposal.digest,
    target: { kind: proposal.target.kind, id: proposal.target.id },
    roleId: proposal.roleId,
    roleVersion: proposal.roleVersion,
    beforeDigest: proposal.before.digest,
    afterDigest: proposal.after.digest,
    evaluation: {
      baselineRunId: evaluation.baselineRunId,
      candidateRunId: evaluation.candidateRunId,
      goldenSetDigest: evaluation.goldenSetDigest,
      baselineAccuracy: evaluation.baselineAccuracy,
      candidateAccuracy: evaluation.candidateAccuracy,
      delta: evaluation.delta,
      caseCount: evaluation.caseCount,
      regressedCaseIds: [...evaluation.regressedCaseIds].sort(),
    },
  });
}

/**
 * Field-by-field difference between two artifact bodies.
 *
 * Rendered first in the console and read first by an approver. A diff that
 * buries the one changed threshold among unchanged fields is a diff that gets
 * approved without being read.
 */
export function diffArtifactContent(
  before: ArtifactContent,
  after: ArtifactContent,
): readonly ArtifactChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes: ArtifactChange[] = [];

  for (const field of fields) {
    const from = before[field];
    const to = after[field];
    if (from === undefined && to !== undefined) {
      changes.push({ field, kind: "added", to: String(to) });
    } else if (from !== undefined && to === undefined) {
      changes.push({ field, kind: "removed", from: String(from) });
    } else if (from !== to) {
      changes.push({ field, kind: "changed", from: String(from), to: String(to) });
    }
  }

  return changes;
}

function summarise(
  proposal: Proposal,
  evaluation: ProposalEvaluation,
  blastRadius: BlastRadius,
): string {
  const changes = diffArtifactContent(proposal.before.content, proposal.after.content)
    .map((change) =>
      change.kind === "changed"
        ? `${change.field}: ${change.from} → ${change.to}`
        : change.kind === "added"
          ? `${change.field}: + ${change.to}`
          : `${change.field}: − ${change.from}`,
    )
    .join("; ");

  return [
    `Apply ${proposal.target.kind} change to "${proposal.target.id}" (v${proposal.before.version} → v${proposal.after.version}).`,
    `Change: ${changes || "no field-level difference"}.`,
    `Why: ${proposal.rationale}`,
    `Measured: ${(evaluation.baselineAccuracy * 100).toFixed(1)}% → ${(evaluation.candidateAccuracy * 100).toFixed(1)}% ` +
      `over ${evaluation.caseCount} case(s) in "${evaluation.goldenSetId}" v${evaluation.goldenSetVersion}; ` +
      `${evaluation.improvedCaseIds.length} case(s) improved, ${evaluation.regressedCaseIds.length} regressed.`,
    `Blast radius: ${blastRadius.roleIds.length} role(s) (${blastRadius.roleNames.join(", ") || "unnamed"}), ` +
      `${blastRadius.workflowKinds.length} workflow(s), ${blastRadius.runCount} run(s) in the last ${blastRadius.windowDays} days, ` +
      `${blastRadius.openRunCount} still in flight.`,
  ].join(" ");
}

/** Exported for the console: is this run still in the air? */
export function isOpenRun(run: Run): boolean {
  return OPEN_RUN_STATUSES.includes(run.status);
}
