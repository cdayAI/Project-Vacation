import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { Authorizer } from "../guard/authorize.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import { isId, type Id } from "../kernel/ids.js";
import type { ActorRef, OperatingMode } from "../record/types.js";
import { assertGoldenSet, assertGoldenSetNotWeakened } from "../roles/evaluation.js";
import type { EvaluationStore } from "../roles/port.js";
import type { GoldenSet } from "../roles/types.js";
import { APPLY_ACTION, REVERT_ACTION } from "./actions.js";
import { approvalDigest } from "./approve.js";
import { assertArtifactContent, assertMutableArtifact } from "./artifacts.js";
import { assertOffered } from "./evaluate.js";
import type { ArtifactStore, ProposalStore } from "./port.js";
import { assertProposalIntact, buildProposedGoldenSet } from "./propose.js";
import type { AppliedChange, ArtifactState, Proposal } from "./types.js";

/**
 * Stage six: apply — and undo.
 *
 * **There is no autonomous application. There is no configuration that
 * disables this gate. There is no flag, no environment variable, and no
 * test-only bypass, and this file is where that stops being a promise.**
 *
 * `apply` requires an approval id that resolves to a granted, unconsumed,
 * unexpired approval bound to a digest of exactly this proposal and exactly the
 * evaluation it was offered on. Anything else — a missing id, a blank id, an id
 * of the wrong shape, an approval for a different proposal, an approval for a
 * different action, one already spent, one still pending, one that has expired
 * — is refused with `improvement.autonomous_application` or the chokepoint's
 * own reason, and every refusal is written to the audit chain as
 * `improvement.refused`. ADR 0011 records why the gate is not configurable, and
 * the tests in this module attempt every bypass listed above and assert each is
 * refused.
 *
 * The pressure to add a bypass is predictable and will not come from bad
 * intentions. It arrives as "auto-apply anything that improves the golden set
 * by more than five percent", or as a flag for the test suite, or as a
 * bulk-approve for a backlog of small changes. Each is locally reasonable.
 * Together they are how a governed system becomes an autonomous one without
 * anybody deciding that it should.
 *
 * Two more properties this file owes:
 *
 * *A snapshot, always.* Applying records the exact prior state — kind, id,
 * version, content, digest — so `revert` is one action against a state a person
 * once chose, rather than a reconstruction from a diff.
 *
 * *Applied once.* The application record is keyed by proposal, in this store
 * and in the schema. Even with every check above bypassed, a proposal cannot be
 * applied twice.
 *
 * The order of checks matters and mirrors the chokepoint's: everything that can
 * refuse for free refuses before the approval is consumed, because consuming an
 * approval is destructive and burning a human's decision on a check that was
 * always going to fail makes them approve again for no reason.
 */

export interface ApplyInput {
  readonly proposalId: Id<"proposal">;
  /**
   * The granted approval this is applied on.
   *
   * Not optional. Not defaulted. There is no code path in this module that
   * reads a configuration value instead.
   */
  readonly approvalId: Id<"approval">;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  /** The operating-record run this application is recorded against. */
  readonly runId: Id<"run">;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export interface RevertInput {
  readonly proposalId: Id<"proposal">;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  readonly runId: Id<"run">;
  /** Why. Recorded, because a rollback is a decision like any other. */
  readonly reason: string;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export interface ImprovementApplierDependencies {
  readonly proposals: ProposalStore;
  readonly artifacts: ArtifactStore;
  readonly evaluations: EvaluationStore;
  readonly authorizer: Authorizer;
  readonly audit: AuditLog;
  readonly clock: Clock;
}

export class ImprovementApplier {
  constructor(private readonly deps: ImprovementApplierDependencies) {}

  /**
   * Apply an approved change.
   *
   * @throws {DeniedError} `improvement.autonomous_application` when there is no
   *   usable approval id, `approval.digest_mismatch` when what was approved is
   *   not what is about to happen, `improvement.evaluation_regression` when the
   *   proposal was never offered, `improvement.protected_case_weakened` when a
   *   golden-set change would weaken existing ground truth, and anything the
   *   authorization chokepoint raises — including a containment switch engaged
   *   between approval and application.
   */
  async apply(input: ApplyInput): Promise<AppliedChange> {
    try {
      return await this.performApply(input);
    } catch (error) {
      await this.recordRefusal(
        {
          proposalId: input.proposalId,
          actor: input.actor,
          runId: input.runId,
          correlationId: input.correlationId,
          attempted: APPLY_ACTION,
          approvalId: input.approvalId,
        },
        error,
      );
      throw error;
    }
  }

  private async performApply(input: ApplyInput): Promise<AppliedChange> {
    const proposal = await this.deps.proposals.requireProposal(input.proposalId);

    // 1. The gate, before anything else. A caller with no approval id is
    //    attempting an autonomous change, and that is refused on its own terms
    //    rather than as a side effect of some later check happening to fail.
    assertHumanDecision(input.approvalId, proposal.id);

    // 2. The stored proposal still describes what it was written to describe.
    //    A row edited after approval is not the proposal anybody reviewed.
    assertProposalIntact(proposal);

    // 3. The proposal is in the one state that can be applied, and the approval
    //    presented is the one its decision names. An approval granted for a
    //    different proposal fails the digest check below as well; failing here
    //    first gives the operator the useful message.
    assertApprovedState(proposal, input.approvalId);

    // 4. The boundaries, re-checked at the moment of effect. They ran when the
    //    proposal was drafted; a stored row is not evidence that they did, and
    //    an older or looser drafting path is exactly the sort of thing that
    //    exists in a system a few years in.
    assertMutableArtifact(proposal.target);
    assertArtifactContent(proposal.target.kind, proposal.after.content);

    // 5. It was measured, and it improved. Re-checked because a proposal can be
    //    re-measured between approval and application.
    const evaluation = assertOffered(proposal);

    // 6. The world still looks the way the approver was shown. Both branches
    //    below compare against the snapshot the proposal carries.
    const goldenSet = await this.prepareInstall(proposal);

    // 7. The chokepoint. This consumes the approval — atomically, single-use,
    //    bound to the digest — and applies containment, operating mode, the
    //    actor's roles, step-up re-authentication, and the ceilings. It is the
    //    only thing that can turn this into an applied change, and it is
    //    deliberately last, because everything above refuses for free.
    const digest: Digest = approvalDigest(proposal);
    await this.deps.authorizer.authorize({
      action: APPLY_ACTION,
      actor: input.actor,
      mode: input.mode,
      runId: input.runId,
      correlationId: input.correlationId,
      approvalId: input.approvalId,
      proposalDigest: digest,
      // `roleId` is deliberately absent. That field means "this role is
      // acting", and a person applying a fix to a role is not the role acting.
      // Setting it would route the change through the per-role containment
      // switch — so a role stopped because it is misbehaving could not have the
      // fix for that misbehaviour applied to it.
      subject: {
        proposalId: proposal.id,
        roleId: proposal.roleId,
        artifactKind: proposal.target.kind,
        artifactId: proposal.target.id,
      },
      secondsSinceAuthentication: input.secondsSinceAuthentication,
    });

    const now = this.deps.clock.nowIso();
    const installed = await this.install(proposal, input, now, goldenSet);

    const application: AppliedChange = {
      proposalId: proposal.id,
      approvalId: input.approvalId,
      target: proposal.target,
      snapshot: proposal.before,
      installed,
      revertible: isRevertible(proposal),
      appliedAt: now,
      appliedBy: input.actor,
      runId: input.runId,
    };

    const recorded = await this.deps.proposals.recordApplication(application);

    const moved = await this.deps.proposals.transitionProposal({
      id: proposal.id,
      expectedStatus: "approved",
      nextStatus: "applied",
    });
    if (!moved) {
      // The artifact is already installed at this point and the approval is
      // spent, so this is reported rather than rolled back: the operator needs
      // to know the change is live and the proposal's status did not follow.
      throw new DeniedError(
        "record.unavailable",
        `Proposal ${proposal.id} was applied, but its status could not be advanced because something else changed it first. The change is live; reconcile the proposal record before applying anything else to "${proposal.target.id}".`,
        { proposalId: proposal.id, artifactId: proposal.target.id },
      );
    }

    await this.deps.audit.record(
      auditDecision({
        eventType: "improvement.applied",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        runId: input.runId,
        correlationId: input.correlationId,
        subject: {
          proposalId: proposal.id,
          roleId: proposal.roleId,
          approvalId: input.approvalId,
          artifactKind: proposal.target.kind,
          artifactId: proposal.target.id,
        },
        inputDigests: {
          proposal: proposal.digest,
          approval: digest,
          snapshot: proposal.before.digest,
          installed: installed.digest,
          goldenSet: evaluation.goldenSetDigest,
        },
        decision: {
          fromVersion: proposal.before.version,
          toVersion: installed.version,
          delta: evaluation.delta,
          candidateAccuracy: evaluation.candidateAccuracy,
          revertible: recorded.revertible,
          // The approval id is on this entry and on the decision entry before
          // it. "Nothing changed without a recorded human decision" is provable
          // from the chain alone.
          approvedBy: proposal.decision?.decidedBy.actorId ?? "",
        },
      }),
    );

    return recorded;
  }

  /**
   * Undo an applied change, in one action.
   *
   * Deliberately easier than applying one: `improvement.revert` is `sensitive`
   * rather than `high_consequence` and carries no approval gate, for the same
   * reason the containment switches do not. An operator watching a bad change
   * misbehave should not be waiting for a second signature, and the state being
   * restored is one a person already approved.
   *
   * @throws {DeniedError} `improvement.protected_case_weakened` when the change
   *   added golden-set cases — those stay; see `isRevertible`. `record.unavailable`
   *   when there is nothing to revert, it has already been reverted, or the
   *   artifact has moved on since.
   */
  async revert(input: RevertInput): Promise<AppliedChange> {
    try {
      return await this.performRevert(input);
    } catch (error) {
      await this.recordRefusal(
        {
          proposalId: input.proposalId,
          actor: input.actor,
          runId: input.runId,
          correlationId: input.correlationId,
          attempted: REVERT_ACTION,
        },
        error,
      );
      throw error;
    }
  }

  private async performRevert(input: RevertInput): Promise<AppliedChange> {
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw new InvalidInputError(
        "A revert needs a reason. Rolling back is a decision, and the record says why it was made.",
        "reason",
      );
    }

    const application = await this.deps.proposals.getApplication(input.proposalId);
    if (!application) {
      throw new DeniedError(
        "record.unavailable",
        `Proposal ${input.proposalId} has never been applied, so there is nothing to revert.`,
        { proposalId: input.proposalId },
      );
    }
    if (application.revertedAt) {
      throw new DeniedError(
        "record.unavailable",
        `Proposal ${input.proposalId} was already reverted at ${application.revertedAt}. Reverting twice would roll back whatever was applied after it.`,
        { proposalId: input.proposalId },
      );
    }
    if (!application.revertible) {
      throw new DeniedError(
        "improvement.protected_case_weakened",
        `Proposal ${input.proposalId} added cases to a golden set, and those cases stay. Removing an expected outcome from the ground truth of record is the one change this platform never makes, and a revert that deleted them would be exactly that change under another name. If an added case is wrong, a curator supersedes it by publishing a corrected version with their name on it.`,
        { proposalId: input.proposalId, artifactKind: application.target.kind },
      );
    }
    if (application.snapshot.version < 1) {
      throw new DeniedError(
        "record.unavailable",
        `Proposal ${input.proposalId} was applied over an artifact that did not exist, so there is no prior state to restore.`,
        { proposalId: input.proposalId },
      );
    }

    await this.deps.authorizer.authorize({
      action: REVERT_ACTION,
      actor: input.actor,
      mode: input.mode,
      runId: input.runId,
      correlationId: input.correlationId,
      subject: {
        proposalId: input.proposalId,
        artifactKind: application.target.kind,
        artifactId: application.target.id,
      },
      secondsSinceAuthentication: input.secondsSinceAuthentication,
    });

    const now = this.deps.clock.nowIso();
    const restored = await this.deps.artifacts.restoreArtifact({
      kind: application.target.kind,
      id: application.target.id,
      toVersion: application.snapshot.version,
      // Compare-and-set against what this application installed. If something
      // else has been applied since, this refuses: restoring a version nobody
      // chose over the one that is live is a second unreviewed change, not an
      // undo of the first.
      expectedHeadVersion: application.installed.version,
      at: now,
      by: input.actor,
    });
    if (!restored) {
      throw new DeniedError(
        "record.unavailable",
        `Artifact "${application.target.id}" is no longer at v${application.installed.version}, so this revert was refused. Something else has been applied since; revert that first, or propose the state you want.`,
        {
          proposalId: input.proposalId,
          artifactId: application.target.id,
          expectedVersion: application.installed.version,
        },
      );
    }

    const reverted = await this.deps.proposals.markReverted({
      proposalId: input.proposalId,
      revertedAt: now,
      revertedBy: input.actor,
      reason: input.reason.slice(0, 512),
    });
    if (!reverted) {
      throw new DeniedError(
        "record.unavailable",
        `Proposal ${input.proposalId} was reverted by another operator while this revert was in flight.`,
        { proposalId: input.proposalId },
      );
    }

    await this.deps.proposals.transitionProposal({
      id: input.proposalId,
      expectedStatus: "applied",
      nextStatus: "reverted",
    });

    await this.deps.audit.record(
      auditDecision({
        eventType: "improvement.reverted",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        runId: input.runId,
        correlationId: input.correlationId,
        subject: {
          proposalId: input.proposalId,
          artifactKind: application.target.kind,
          artifactId: application.target.id,
          approvalId: application.approvalId,
        },
        inputDigests: {
          restored: application.snapshot.digest,
          rolledOff: application.installed.digest,
        },
        decision: {
          fromVersion: application.installed.version,
          toVersion: application.snapshot.version,
          reason: input.reason.slice(0, 512),
        },
      }),
    );

    return reverted;
  }

  /**
   * Check that the world still matches the snapshot, before anything is spent.
   *
   * Returns the golden set to publish for an `evaluation_case` change, so that
   * the guard runs against the set as it is *now* rather than as it was when
   * the proposal was drafted.
   */
  private async prepareInstall(proposal: Proposal): Promise<GoldenSet | null> {
    if (proposal.target.kind === "evaluation_case") {
      const current = await this.deps.evaluations.requireGoldenSet(proposal.target.id);
      if (current.version !== proposal.before.version) {
        throw new DeniedError(
          "approval.digest_mismatch",
          `Golden set "${proposal.target.id}" is at v${current.version}; this proposal was approved against v${proposal.before.version}. The ground truth has moved since the approver saw it.`,
          {
            proposalId: proposal.id,
            goldenSetId: proposal.target.id,
            currentVersion: current.version,
          },
        );
      }

      const proposed = buildProposedGoldenSet(current, proposal.addedCases);
      // Run again at the moment of effect. The drafting check proves the
      // proposal was sound when it was written; this proves it is sound
      // against the set that actually exists now.
      assertGoldenSet(proposed);
      assertGoldenSetNotWeakened(current, proposed);
      return proposed;
    }

    const head = await this.deps.artifacts.head(proposal.target.kind, proposal.target.id);
    if (!head) {
      throw new DeniedError(
        "record.unavailable",
        `Artifact "${proposal.target.id}" (${proposal.target.kind}) is not in the governed record, so there is nothing to change and no prior state to snapshot.`,
        { proposalId: proposal.id, artifactId: proposal.target.id },
      );
    }
    if (head.digest !== proposal.before.digest) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Artifact "${proposal.target.id}" is at v${head.version}, which is not the state this proposal was approved against (v${proposal.before.version}). What was approved is not what would be changed.`,
        {
          proposalId: proposal.id,
          artifactId: proposal.target.id,
          currentVersion: head.version,
          approvedAgainstVersion: proposal.before.version,
        },
      );
    }
    return null;
  }

  /** Put the change in place. Called only after the approval has been spent. */
  private async install(
    proposal: Proposal,
    input: ApplyInput,
    at: string,
    goldenSet: GoldenSet | null,
  ): Promise<ArtifactState> {
    if (goldenSet) {
      // Golden sets belong to `roles/`, are immutable per version, and are
      // published through the store that enforces that. This module does not
      // keep a second copy of the ground truth.
      const published = await this.deps.evaluations.putGoldenSet(goldenSet);
      return {
        ...proposal.after,
        version: published.version,
      };
    }

    const installed = await this.deps.artifacts.installArtifact({
      artifact: {
        ...proposal.after,
        recordedAt: at,
        recordedBy: input.actor,
        proposalId: proposal.id,
        approvalId: input.approvalId,
      },
      expectedHeadVersion: proposal.before.version,
    });
    if (!installed) {
      // The approval has been consumed by now, and that is the correct trade:
      // an approval is single-use precisely so a decision cannot be replayed
      // against a state its approver never saw. The loser raises a fresh
      // approval against the state that actually exists.
      throw new DeniedError(
        "record.unavailable",
        `Artifact "${proposal.target.id}" was changed by another operator while this application was in flight, so it was refused rather than applied over a state its approver never saw.`,
        { proposalId: proposal.id, artifactId: proposal.target.id },
      );
    }

    return {
      kind: installed.kind,
      id: installed.id,
      version: installed.version,
      content: installed.content,
      digest: installed.digest,
    };
  }

  /**
   * Write the refusal to the chain.
   *
   * Every refused application is a security-relevant event: something asked
   * this platform to change its own behaviour and was told no. The reason it is
   * recorded rather than merely thrown is that the interesting pattern is not
   * one refusal, it is fifty.
   */
  private async recordRefusal(
    context: {
      readonly proposalId: Id<"proposal">;
      readonly actor: ActorRef;
      readonly runId: Id<"run">;
      readonly correlationId?: string | undefined;
      readonly attempted: string;
      readonly approvalId?: Id<"approval"> | undefined;
    },
    error: unknown,
  ): Promise<void> {
    const reason =
      error instanceof DeniedError
        ? error.reason
        : error instanceof InvalidInputError
          ? "invalid_input"
          : "unhandled_error";

    try {
      await this.deps.audit.record(
        auditDecision({
          eventType: "improvement.refused",
          actorId: context.actor.actorId,
          actorKind: context.actor.kind,
          actorRoles: context.actor.roles,
          runId: context.runId,
          correlationId: context.correlationId,
          subject: {
            proposalId: context.proposalId,
            action: context.attempted,
            ...(context.approvalId ? { approvalId: String(context.approvalId) } : {}),
          },
          decision: {
            reason,
            approvalPresented: Boolean(context.approvalId),
            message:
              error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
          },
        }),
      );
    } catch {
      // allow-swallow: the refusal below this is the outcome that matters and
      // must not be replaced by an audit-write error. The original error is
      // re-raised by the caller either way, so nothing proceeds.
    }
  }
}

/**
 * Refuse an application with no usable human decision behind it.
 *
 * This is the sentence the whole module exists for. Note what it does *not*
 * do: it does not consult configuration, it has no parameter that relaxes it,
 * and there is no sibling function that skips it. Adding one would be a change
 * to ADR 0011 and to the tests that enforce it, argued in the open.
 *
 * @throws {DeniedError} `improvement.autonomous_application`
 */
export function assertHumanDecision(
  approvalId: Id<"approval"> | undefined,
  proposalId: Id<"proposal">,
): asserts approvalId is Id<"approval"> {
  if (typeof approvalId !== "string" || approvalId.trim().length === 0) {
    throw new DeniedError(
      "improvement.autonomous_application",
      `Applying proposal ${proposalId} was attempted with no approval id. Nothing changes this platform's behaviour without a recorded human decision, and there is no configuration that removes this gate.`,
      { proposalId, shape: "no_approval_presented" },
    );
  }
  if (!isId(approvalId, "approval")) {
    throw new DeniedError(
      "improvement.autonomous_application",
      `Applying proposal ${proposalId} was attempted with "${approvalId}", which is not an approval identifier. An approval id names a human decision; anything else is an attempt to proceed without one.`,
      { proposalId, shape: "not_an_approval_id" },
    );
  }
}

/**
 * Refuse a proposal that is not sitting on a granted decision naming this
 * approval.
 *
 * @throws {DeniedError} `improvement.autonomous_application` when the proposal
 *   was never approved, `approval.digest_mismatch` when it was approved on a
 *   different approval than the one presented.
 */
export function assertApprovedState(proposal: Proposal, approvalId: Id<"approval">): void {
  if (proposal.status !== "approved") {
    throw new DeniedError(
      "improvement.autonomous_application",
      `Proposal ${proposal.id} is ${proposal.status}, not approved. A change becomes applicable when a person with authority decides it should, and at no other point.`,
      { proposalId: proposal.id, status: proposal.status, shape: "not_approved" },
    );
  }

  const decision = proposal.decision;
  if (!decision || decision.decision !== "granted") {
    throw new DeniedError(
      "improvement.autonomous_application",
      `Proposal ${proposal.id} carries no granted decision, so there is no human decision to apply it on.`,
      { proposalId: proposal.id, shape: "no_granted_decision" },
    );
  }

  if (decision.approvalId !== approvalId) {
    throw new DeniedError(
      "approval.digest_mismatch",
      `Proposal ${proposal.id} was approved on ${decision.approvalId}, and ${approvalId} was presented instead. An approval granted elsewhere does not authorise this change.`,
      { proposalId: proposal.id, approvalId },
    );
  }
}

/**
 * Whether an applied change can be rolled back.
 *
 * Everything except a golden-set addition. The cases stay: see `revert`.
 */
export function isRevertible(proposal: Proposal): boolean {
  return proposal.target.kind !== "evaluation_case";
}
