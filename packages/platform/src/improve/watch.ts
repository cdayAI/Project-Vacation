import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { Logger } from "../kernel/logger.js";
import type { RunStore } from "../record/port.js";
import type { ActorRef } from "../record/types.js";
import type { EvaluationStore } from "../roles/port.js";
import type { EvaluationRun } from "../roles/types.js";
import { REVERT_ACTION } from "./actions.js";
import type { ObservationStore, ProposalStore } from "./port.js";
import type {
  AppliedChange,
  CorrectionRate,
  Proposal,
  ProposalEvaluation,
  QualitySample,
  RevertOffer,
  WatchReport,
} from "./types.js";

/**
 * Stage seven: watch.
 *
 * A change that measured well in a trial and then made things worse in
 * production is the failure mode this stage exists for. It tracks post-change
 * quality against the pre-change baseline and, when the numbers turn, alerts
 * and puts the revert in front of a person.
 *
 * Two signals, because they fail differently:
 *
 *   *The golden set*, re-measured after the change and compared with the
 *   baseline the change was judged against. Precise, and blind to anything the
 *   cases do not cover.
 *
 *   *The correction rate*, counted from the operating record: corrections per
 *   run in the window since the change, against the same length of window
 *   before it. Noisy, and it sees what the cases do not — operators quietly
 *   fixing more work than they used to.
 *
 * **The watch does not revert anything.** It returns a `RevertOffer`, which is
 * data: the proposal id, the action, and whether it is available. An automatic
 * rollback is still the platform changing its behaviour on its own authority,
 * and ADR 0011 refused that trade explicitly — automatic rollback only catches
 * the regressions the metrics happen to measure, and in a regulated context the
 * failures that matter are frequently the ones they do not. What the watch owes
 * a person is the numbers and the one action that undoes the change; the
 * decision stays theirs.
 */

/** Post-change measurement windows shorter than this prove nothing either way. */
const MINIMUM_COMPARISON_MS = 60 * 1000;

export interface ImprovementWatchDependencies {
  readonly proposals: ProposalStore;
  readonly observations: ObservationStore;
  readonly evaluations: EvaluationStore;
  readonly runs: RunStore;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface RecordSampleInput {
  readonly proposalId: Id<"proposal">;
  /** A fresh evaluation run of the affected role, taken after the change. */
  readonly run: EvaluationRun;
  readonly actor: ActorRef;
  readonly correlationId?: string | undefined;
}

export class ImprovementWatch {
  constructor(private readonly deps: ImprovementWatchDependencies) {}

  /**
   * Record one post-change measurement.
   *
   * @throws {DeniedError} `record.unavailable` when the proposal was never
   *   applied, `approval.digest_mismatch` when the measurement was taken
   *   against a different set of cases than the baseline — which is not a
   *   comparison, whichever way the number moved.
   */
  async recordSample(input: RecordSampleInput): Promise<QualitySample> {
    const proposal = await this.deps.proposals.requireProposal(input.proposalId);
    const evaluation = requireEvaluation(proposal);
    const application = await this.requireApplication(input.proposalId);

    if (input.run.roleId !== proposal.roleId) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Evaluation run ${input.run.id} measured role ${input.run.roleId}, not ${proposal.roleId}, so it says nothing about this change.`,
        { proposalId: proposal.id, evaluationRunId: input.run.id },
      );
    }
    if (input.run.goldenSetDigest !== evaluation.goldenSetDigest) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Evaluation run ${input.run.id} was measured against "${input.run.goldenSetId}" v${input.run.goldenSetVersion}, and the baseline against "${evaluation.goldenSetId}" v${evaluation.goldenSetVersion}. Comparing accuracies over different cases is not tracking quality, it is producing a number.`,
        { proposalId: proposal.id, evaluationRunId: input.run.id },
      );
    }

    const sample: QualitySample = {
      proposalId: proposal.id,
      evaluationRunId: input.run.id,
      goldenSetDigest: input.run.goldenSetDigest,
      accuracy: input.run.accuracy,
      caseCount: input.run.caseCount,
      regressedCaseIds: await this.regressionsAgainstTrial(evaluation, input.run),
      observedAt: this.deps.clock.nowIso(),
    };

    const recorded = await this.deps.proposals.recordQualitySample(sample);

    await this.deps.audit.record(
      auditDecision({
        eventType: "improvement.proposal_evaluated",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        runId: input.run.runId,
        correlationId: input.correlationId,
        subject: {
          proposalId: proposal.id,
          roleId: proposal.roleId,
          evaluationRunId: input.run.id,
          approvalId: application.approvalId,
        },
        inputDigests: {
          proposal: proposal.digest,
          goldenSet: input.run.goldenSetDigest,
        },
        decision: {
          phase: "post_change",
          accuracy: recorded.accuracy,
          baselineAccuracy: evaluation.baselineAccuracy,
          trialAccuracy: evaluation.candidateAccuracy,
          regressed: recorded.regressedCaseIds.length,
          cases: recorded.caseCount,
        },
      }),
    );

    return recorded;
  }

  /**
   * How the change is doing, and the offer to undo it.
   *
   * @throws {DeniedError} `record.unavailable` when the proposal was never
   *   applied. There is nothing to watch before a change is live, and an empty
   *   report would read as "no problems found".
   */
  async assess(
    proposalId: Id<"proposal">,
    options: { readonly correlationId?: string | undefined } = {},
  ): Promise<WatchReport> {
    const proposal = await this.deps.proposals.requireProposal(proposalId);
    const evaluation = requireEvaluation(proposal);
    const application = await this.requireApplication(proposalId);

    const samples = await this.deps.proposals.listQualitySamples(proposalId);
    const latest = samples[samples.length - 1];

    // With no post-change sample yet, the most recent measurement of the
    // changed system is the trial that justified it. Saying so is honest;
    // inventing a zero would report a catastrophic regression on day one.
    const latestAccuracy = latest ? latest.accuracy : evaluation.candidateAccuracy;
    const regressedCaseIds = latest ? latest.regressedCaseIds : [];
    const delta = round5(latestAccuracy - evaluation.baselineAccuracy);

    const corrections = await this.correctionRate(proposal, application);

    const reasons: string[] = [];
    if (latest && delta <= 0) {
      reasons.push(
        `accuracy is ${percent(latestAccuracy)} against a pre-change baseline of ${percent(evaluation.baselineAccuracy)}: the change has not held`,
      );
    }
    if (regressedCaseIds.length > 0) {
      reasons.push(
        `${regressedCaseIds.length} case(s) the change was measured to fix no longer pass: ${[...regressedCaseIds].sort().join(", ")}`,
      );
    }
    if (corrections.comparable && corrections.afterRate > corrections.beforeRate) {
      reasons.push(
        `operators are correcting ${rate(corrections.afterRate)} of runs, up from ${rate(corrections.beforeRate)} before the change`,
      );
    }

    const report: WatchReport = {
      proposalId,
      baselineAccuracy: evaluation.baselineAccuracy,
      latestAccuracy,
      delta,
      sampleCount: samples.length,
      regressed: reasons.length > 0,
      regressedCaseIds,
      corrections,
      reasons,
      revert: revertOffer(application),
      assessedAt: this.deps.clock.nowIso(),
    };

    if (report.regressed) {
      // The alert. Warn rather than error: a regression is the watch working,
      // and logging it at error level trains operators to ignore errors. The
      // report itself is what the console renders, with the revert on it.
      this.deps.logger.warn("improvement change is regressing", {
        correlationId: options.correlationId,
        proposalId,
        artifactId: application.target.id,
        delta,
        reasons: reasons.join("; "),
        revertAvailable: report.revert.available,
      });
    }

    return report;
  }

  /** Every applied change that is currently regressing. The operator's queue. */
  async regressions(): Promise<readonly WatchReport[]> {
    const applications = await this.deps.proposals.listApplications({ reverted: false });
    const reports: WatchReport[] = [];
    for (const application of applications) {
      const report = await this.assess(application.proposalId);
      if (report.regressed) reports.push(report);
    }
    return reports;
  }

  /**
   * Cases the trial said would pass and that do not pass now.
   *
   * Compared against the candidate run recorded at trial time — the real
   * evidence, read back from the evaluation store rather than duplicated onto
   * the proposal. When that run is no longer available the per-case comparison
   * is skipped rather than guessed, and the accuracy signal carries the report.
   */
  private async regressionsAgainstTrial(
    evaluation: ProposalEvaluation,
    run: EvaluationRun,
  ): Promise<readonly string[]> {
    const candidate = await this.deps.evaluations.getEvaluation(evaluation.candidateRunId);
    if (!candidate) return [];

    const now = new Map(run.results.map((entry) => [entry.caseId, entry.outcome]));
    const regressed: string[] = [];
    for (const entry of candidate.results) {
      if (entry.outcome !== "passed") continue;
      if (now.get(entry.caseId) !== "passed") regressed.push(entry.caseId);
    }
    return regressed.sort();
  }

  /**
   * Corrections per run, before and after the change.
   *
   * The windows are the same length by construction — however long it has been
   * since the change, measured backwards from the moment it landed — so a
   * change applied an hour ago is not compared against a month of history.
   */
  private async correctionRate(
    proposal: Proposal,
    application: AppliedChange,
  ): Promise<CorrectionRate> {
    const appliedMs = Date.parse(application.appliedAt);
    const elapsedMs = this.deps.clock.now() - appliedMs;

    if (!Number.isFinite(appliedMs) || elapsedMs < MINIMUM_COMPARISON_MS) {
      return {
        comparable: false,
        windowMs: Math.max(0, elapsedMs),
        beforeCorrections: 0,
        beforeRuns: 0,
        beforeRate: 0,
        afterCorrections: 0,
        afterRuns: 0,
        afterRate: 0,
      };
    }

    // The filters are strictly-after and strictly-before in both adapters, so
    // the bounds are nudged by a millisecond to make each window inclusive of
    // the instants it is meant to cover. Without this, work recorded at exactly
    // the moment of the change would fall into neither window — which, under a
    // fixed clock, is most of it.
    //
    // The instant of the change itself belongs to the *before* window: work
    // recorded at the same millisecond as the change cannot have been
    // influenced by it, and counting it as "after" would attribute the old
    // behaviour's corrections to the new behaviour.
    const windowStart = new Date(appliedMs - elapsedMs - 1).toISOString();
    const changeInstant = new Date(appliedMs).toISOString();
    const justAfterChange = new Date(appliedMs + 1).toISOString();
    const now = new Date(this.deps.clock.now() + 1).toISOString();

    const roleId = proposal.roleId;

    const beforeCorrections = await this.deps.observations.countObservations({
      roleId,
      recordedAfter: windowStart,
      recordedBefore: justAfterChange,
    });
    const beforeRuns = await this.deps.runs.countRuns({
      roleId,
      createdAfter: windowStart,
      createdBefore: justAfterChange,
    });
    const afterCorrections = await this.deps.observations.countObservations({
      roleId,
      recordedAfter: changeInstant,
      recordedBefore: now,
    });
    const afterRuns = await this.deps.runs.countRuns({
      roleId,
      createdAfter: changeInstant,
      createdBefore: now,
    });

    return {
      comparable: beforeRuns > 0 && afterRuns > 0,
      windowMs: elapsedMs,
      beforeCorrections,
      beforeRuns,
      beforeRate: beforeRuns === 0 ? 0 : round5(beforeCorrections / beforeRuns),
      afterCorrections,
      afterRuns,
      afterRate: afterRuns === 0 ? 0 : round5(afterCorrections / afterRuns),
    };
  }

  private async requireApplication(proposalId: Id<"proposal">): Promise<AppliedChange> {
    const application = await this.deps.proposals.getApplication(proposalId);
    if (!application) {
      throw new DeniedError(
        "record.unavailable",
        `Proposal ${proposalId} has never been applied, so there is no post-change quality to watch. An empty report here would read as "no problems found".`,
        { proposalId },
      );
    }
    return application;
  }
}

/**
 * The one action that undoes the change.
 *
 * Inert data. `available` is false once the change has been reverted, and for a
 * golden-set addition, which is not revertible — the cases stay.
 */
export function revertOffer(application: AppliedChange): RevertOffer {
  const unavailableReason = application.revertedAt
    ? `already reverted at ${application.revertedAt}`
    : application.revertible
      ? ""
      : "adding cases to a golden set is not reverted: removing an expected outcome from the ground truth of record is the one change this platform never makes";

  return {
    proposalId: application.proposalId,
    action: REVERT_ACTION,
    available: unavailableReason === "",
    unavailableReason,
    restoresVersion: application.snapshot.version,
  };
}

function requireEvaluation(proposal: Proposal): ProposalEvaluation {
  const evaluation = proposal.evaluation;
  if (!evaluation) {
    throw new DeniedError(
      "improvement.evaluation_regression",
      `Proposal ${proposal.id} carries no evaluation, so there is no pre-change baseline to track against.`,
      { proposalId: proposal.id },
    );
  }
  return evaluation;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function rate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function round5(value: number): number {
  return Number(value.toFixed(5));
}
