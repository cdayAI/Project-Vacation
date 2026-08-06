import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { Authorizer } from "../guard/authorize.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, OperatingMode } from "../record/types.js";
import type { EvaluationRun } from "../roles/types.js";
import { EVALUATE_ACTION } from "./actions.js";
import type { ProposalStore, ProposalTrial, TrialResult } from "./port.js";
import { assertProposalIntact, freezeProposal } from "./propose.js";
import type { Proposal, ProposalEvaluation } from "./types.js";

/**
 * Stage four: evaluate.
 *
 * **Every proposal is scored against the affected role's golden set before a
 * human sees a recommendation, and a change that does not improve measured
 * quality is not offered.**
 *
 * That sentence is the reason this stage exists, and the reason it sits before
 * the approval queue rather than beside it. A review queue is a claim on the
 * scarcest resource in the system — a qualified person's attention — and a
 * queue full of plausible changes that turn out not to help is how that
 * resource gets spent until nobody reads the queue carefully any more. So the
 * filter runs first, automatically, and the queue only ever contains changes
 * that have already demonstrated an improvement.
 *
 * Four things withhold a proposal, and each is a different failure:
 *
 *   no improvement          the delta is zero or negative. Nothing to offer.
 *   a regression            some case passed before and does not now. Moving
 *                           quality from one case to another is not improving
 *                           it, and an aggregate hides exactly that.
 *   an errored case         the trial did not measure what it claims to.
 *   below the threshold     the candidate is better and still not good enough.
 *
 * Withholding is a normal outcome and does not throw: most ideas are not
 * improvements, and that is information rather than an error. A *rigged* trial
 * is different and does throw — if the candidate was measured against a
 * different set of cases than the baseline, the comparison is meaningless, and
 * measuring against an easier set is the cheapest way to manufacture a result.
 */

export interface EvaluateProposalInput {
  readonly proposalId: Id<"proposal">;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  /** The operating-record run the trial's model calls are charged to. */
  readonly runId: Id<"run">;
  readonly correlationId?: string | undefined;
  /**
   * How much better the candidate must be. Default 0, meaning strictly better.
   *
   * Raising it makes the loop pickier. It cannot be lowered below zero: a
   * negative gain is a regression, and there is no configuration in this module
   * that offers one.
   */
  readonly minimumGain?: number | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export interface EvaluatedProposal {
  readonly proposal: Proposal;
  readonly evaluation: ProposalEvaluation;
}

export interface ProposalEvaluatorDependencies {
  readonly proposals: ProposalStore;
  readonly trial: ProposalTrial;
  readonly authorizer: Authorizer;
  readonly audit: AuditLog;
  readonly clock: Clock;
}

/** Statuses a proposal may be measured from. */
const MEASURABLE_STATUSES = ["drafted", "withheld"] as const;

export class ProposalEvaluator {
  constructor(private readonly deps: ProposalEvaluatorDependencies) {}

  /**
   * Measure a proposal and decide whether it may be offered to a human.
   *
   * @throws {DeniedError} `approval.digest_mismatch` when the trial's two runs
   *   do not describe the same comparison, and anything the chokepoint raises.
   */
  async evaluate(input: EvaluateProposalInput): Promise<EvaluatedProposal> {
    const proposal = await this.deps.proposals.requireProposal(input.proposalId);
    assertProposalIntact(proposal);

    if (!(MEASURABLE_STATUSES as readonly string[]).includes(proposal.status)) {
      throw new DeniedError(
        "improvement.evaluation_regression",
        `Proposal ${proposal.id} is ${proposal.status}. Only a drafted or previously withheld proposal is measured; re-measuring one that has been decided on would change the evidence under a decision somebody has already made.`,
        { proposalId: proposal.id, status: proposal.status },
      );
    }

    await this.deps.authorizer.authorize({
      action: EVALUATE_ACTION,
      actor: input.actor,
      mode: input.mode,
      runId: input.runId,
      correlationId: input.correlationId,
      subject: {
        proposalId: proposal.id,
        roleId: proposal.roleId,
        artifactKind: proposal.target.kind,
        artifactId: proposal.target.id,
      },
      secondsSinceAuthentication: input.secondsSinceAuthentication,
    });

    const trial = await this.deps.trial.measure({
      proposal,
      actor: input.actor,
      mode: input.mode,
      runId: input.runId,
      correlationId: input.correlationId,
    });

    assertComparableTrial(proposal, trial);

    const evaluation = assessTrial(trial, {
      minimumGain: Math.max(0, input.minimumGain ?? 0),
      evaluatedAt: this.deps.clock.nowIso(),
    });

    const moved = await this.deps.proposals.transitionProposal({
      id: proposal.id,
      expectedStatus: proposal.status,
      nextStatus: evaluation.offered ? "offered" : "withheld",
      patch: { evaluation },
    });
    if (!moved) {
      throw new DeniedError(
        "record.unavailable",
        `Proposal ${proposal.id} was changed by someone else while it was being measured, so this result was discarded rather than written over a state it never saw.`,
        { proposalId: proposal.id },
      );
    }

    await this.deps.audit.record(
      auditDecision({
        eventType: "improvement.proposal_evaluated",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        runId: input.runId,
        correlationId: input.correlationId,
        subject: {
          proposalId: proposal.id,
          roleId: proposal.roleId,
          goldenSetId: evaluation.goldenSetId,
          baselineRunId: evaluation.baselineRunId,
          candidateRunId: evaluation.candidateRunId,
        },
        inputDigests: {
          proposal: proposal.digest,
          goldenSet: evaluation.goldenSetDigest,
        },
        decision: {
          phase: "pre_change",
          offered: evaluation.offered,
          baselineAccuracy: evaluation.baselineAccuracy,
          candidateAccuracy: evaluation.candidateAccuracy,
          delta: evaluation.delta,
          cases: evaluation.caseCount,
          regressed: evaluation.regressedCaseIds.length,
          improved: evaluation.improvedCaseIds.length,
          ...(evaluation.withheldReason ? { withheldReason: evaluation.withheldReason } : {}),
        },
      }),
    );

    return { proposal: freezeProposal(moved), evaluation };
  }
}

/**
 * Refuse a trial whose two runs do not describe the same comparison.
 *
 * Every branch raises `approval.digest_mismatch`, and deliberately: this is the
 * same failure that reason exists for elsewhere — what was measured is not what
 * is being claimed — one step earlier in the chain.
 *
 * @throws {DeniedError} `approval.digest_mismatch`
 */
export function assertComparableTrial(proposal: Proposal, trial: TrialResult): void {
  const { baseline, candidate } = trial;

  if (baseline.id === candidate.id) {
    throw new DeniedError(
      "approval.digest_mismatch",
      `The trial for proposal ${proposal.id} cites evaluation run ${baseline.id} as both the baseline and the candidate. One run compared with itself always shows no change.`,
      { proposalId: proposal.id, evaluationRunId: baseline.id },
    );
  }

  if (baseline.roleId !== proposal.roleId || candidate.roleId !== proposal.roleId) {
    throw new DeniedError(
      "approval.digest_mismatch",
      `The trial for proposal ${proposal.id} measured role ${candidate.roleId}, not ${proposal.roleId}. A change is judged by the quality of the role it affects.`,
      { proposalId: proposal.id, roleId: proposal.roleId },
    );
  }

  if (
    baseline.goldenSetId !== candidate.goldenSetId ||
    baseline.goldenSetVersion !== candidate.goldenSetVersion ||
    baseline.goldenSetDigest !== candidate.goldenSetDigest
  ) {
    // The obvious way to manufacture an improvement: measure the candidate
    // against an easier set. Checked rather than trusted.
    throw new DeniedError(
      "approval.digest_mismatch",
      `The trial for proposal ${proposal.id} measured the baseline against "${baseline.goldenSetId}" v${baseline.goldenSetVersion} and the candidate against "${candidate.goldenSetId}" v${candidate.goldenSetVersion}. Two different sets of cases are not a comparison.`,
      { proposalId: proposal.id, baseline: baseline.goldenSetId, candidate: candidate.goldenSetId },
    );
  }

  if (baseline.caseCount !== candidate.caseCount) {
    throw new DeniedError(
      "approval.digest_mismatch",
      `The trial for proposal ${proposal.id} ran ${baseline.caseCount} baseline cases and ${candidate.caseCount} candidate cases. An accuracy computed over different denominators is not a delta.`,
      { proposalId: proposal.id },
    );
  }

  if (baseline.errored > 0) {
    throw new DeniedError(
      "approval.digest_mismatch",
      `The baseline run ${baseline.id} for proposal ${proposal.id} had ${baseline.errored} errored case(s), so the figure the candidate is being compared against does not describe what it claims to.`,
      { proposalId: proposal.id, evaluationRunId: baseline.id, errored: baseline.errored },
    );
  }
}

/**
 * Turn a trial into the decision about whether to offer it.
 *
 * Pure: the same two runs always produce the same verdict, which is what lets
 * the seeded demo reproduce and lets this be tested without a harness.
 */
export function assessTrial(
  trial: TrialResult,
  options: { readonly minimumGain: number; readonly evaluatedAt: string },
): ProposalEvaluation {
  const { baseline, candidate } = trial;

  const baselineOutcomes = new Map(baseline.results.map((entry) => [entry.caseId, entry.outcome]));
  const candidateOutcomes = new Map(
    candidate.results.map((entry) => [entry.caseId, entry.outcome]),
  );

  const regressedCaseIds: string[] = [];
  for (const [caseId, outcome] of baselineOutcomes) {
    if (outcome !== "passed") continue;
    // A case that has vanished from the candidate counts as a regression: the
    // baseline proved something about it and the candidate proves nothing.
    if (candidateOutcomes.get(caseId) !== "passed") regressedCaseIds.push(caseId);
  }

  const improvedCaseIds: string[] = [];
  for (const [caseId, outcome] of candidateOutcomes) {
    if (outcome !== "passed") continue;
    if (baselineOutcomes.get(caseId) !== "passed") improvedCaseIds.push(caseId);
  }

  const delta = round5(candidate.accuracy - baseline.accuracy);
  const withheldReason = withholdReason(baseline, candidate, delta, regressedCaseIds, options);

  return {
    baselineRunId: baseline.id,
    candidateRunId: candidate.id,
    goldenSetId: candidate.goldenSetId,
    goldenSetVersion: candidate.goldenSetVersion,
    goldenSetDigest: candidate.goldenSetDigest,
    caseCount: candidate.caseCount,
    baselineAccuracy: baseline.accuracy,
    candidateAccuracy: candidate.accuracy,
    delta,
    regressedCaseIds: regressedCaseIds.sort(),
    improvedCaseIds: improvedCaseIds.sort(),
    offered: withheldReason === "",
    withheldReason,
    evaluatedAt: options.evaluatedAt,
  };
}

function withholdReason(
  baseline: EvaluationRun,
  candidate: EvaluationRun,
  delta: number,
  regressedCaseIds: readonly string[],
  options: { readonly minimumGain: number },
): string {
  if (candidate.errored > 0) {
    return `${candidate.errored} case(s) errored in the candidate run, so it did not measure what it claims to.`;
  }
  if (regressedCaseIds.length > 0) {
    return `${regressedCaseIds.length} case(s) that passed before no longer pass: ${[...regressedCaseIds].sort().join(", ")}. Moving quality from one case to another is not improving it.`;
  }
  if (delta <= 0) {
    return `Measured quality went from ${percent(baseline.accuracy)} to ${percent(candidate.accuracy)}. A change that does not improve measured quality is not offered to anybody.`;
  }
  if (delta < options.minimumGain) {
    return `Measured quality improved by ${percent(delta)}, below the ${percent(options.minimumGain)} a proposal must gain to be worth a reviewer's attention.`;
  }
  if (!candidate.meetsThreshold) {
    return `The candidate reached ${percent(candidate.accuracy)}, still below the golden set's threshold of ${percent(candidate.threshold)}. Better is not the same as good enough.`;
  }
  return "";
}

/**
 * Refuse a proposal that has not earned a place in front of a human.
 *
 * Used by the approval path and again by the applying path. Checking it twice
 * is deliberate: the second check is what makes a proposal that was approved
 * and then re-measured into a withheld one unapplicable.
 *
 * @throws {DeniedError} `improvement.evaluation_regression`
 */
export function assertOffered(proposal: Proposal): ProposalEvaluation {
  const evaluation = proposal.evaluation;
  if (!evaluation) {
    throw new DeniedError(
      "improvement.evaluation_regression",
      `Proposal ${proposal.id} has never been measured. Every proposal is scored against the affected role's golden set before a human sees it, so an unmeasured one cannot be offered, approved, or applied.`,
      { proposalId: proposal.id },
    );
  }
  if (!evaluation.offered) {
    throw new DeniedError(
      "improvement.evaluation_regression",
      `Proposal ${proposal.id} was withheld: ${evaluation.withheldReason}`,
      {
        proposalId: proposal.id,
        delta: evaluation.delta,
        regressions: evaluation.regressedCaseIds.length,
      },
    );
  }
  return evaluation;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** Five decimal places, matching the accuracy figures this compares. */
function round5(value: number): number {
  return Number(value.toFixed(5));
}
