import type { Id } from "../kernel/ids.js";
import type { Platform } from "../platform.js";
import type { ArtifactState, Proposal } from "../improve/types.js";
import { evaluationView, type EvaluationView } from "./role-registry.js";

/**
 * An improvement proposal, as an approver reads it.
 *
 * A proposal is a candidate change to a declarative artifact — a prompt
 * binding, a routing rule, a guardrail threshold — drawn from a cluster of
 * recorded failures. It is inert: there is nothing on it to invoke, and turning
 * it into a live change needs a measured evaluation and a recorded human
 * approval that no configuration removes (ADR 0011).
 *
 * **On a fresh deployment this list is empty, and that is the truth.** The stage
 * that drafts a proposal is deliberately not wired to any route, so
 * `listProposals` returns nothing and the console renders "no proposals". This
 * file does not seed one to make the screen look busy — an invented proposal is
 * a recommendation nobody's evidence supports.
 *
 * **What the record can and cannot source.** The proposal's own fields — its
 * rationale, the before/after artifact state, the cluster it came from — are on
 * the record. The evaluation deltas are present only once the proposal has been
 * measured, and are absent until then rather than shown as zero. The blast
 * radius is the recorded one when a decision has been made against it (that is
 * the state the approver was shown); before a decision it is computed live from
 * the operating record for the proposal's own role, so the number is one an
 * operator could count rather than a stored estimate that might be stale.
 */

export interface ImprovementProposalView {
  readonly proposalId: string;
  readonly kind: string;
  readonly title: string;
  readonly rationale: string;
  readonly artifactKind: string;
  readonly artifactRef: string;
  readonly before: string;
  readonly after: string;
  readonly evaluationBefore?: EvaluationView | undefined;
  readonly evaluationAfter?: EvaluationView | undefined;
  readonly evaluationDelta?: number | undefined;
  readonly blastRadius: {
    readonly roles: readonly string[];
    readonly workflows: readonly string[];
    readonly runsInLastThirtyDays: number;
  };
  readonly observationCount: number;
  readonly createdAt: string;
  readonly status: string;
}

const BLAST_RADIUS_WINDOW_DAYS = 30;

/** A flat declarative artifact rendered as readable `key: value` lines. */
function renderArtifact(state: ArtifactState): string {
  const keys = Object.keys(state.content).sort();
  if (keys.length === 0) return "(empty)";
  return keys.map((key) => `${key}: ${String(state.content[key])}`).join("\n");
}

/** A short human title, since a proposal carries a target rather than a name. */
function titleFor(proposal: Proposal): string {
  const kind = proposal.target.kind.replace(/_/g, " ");
  return `${kind}: ${proposal.target.id}`;
}

async function blastRadius(
  platform: Platform,
  proposal: Proposal,
): Promise<ImprovementProposalView["blastRadius"]> {
  // The state the approver was actually shown, when there was a decision.
  if (proposal.decision) {
    const recorded = proposal.decision.blastRadius;
    return {
      roles: recorded.roleNames.length > 0 ? recorded.roleNames : recorded.roleIds,
      workflows: recorded.workflowKinds,
      runsInLastThirtyDays: recorded.runCount,
    };
  }

  // No decision yet: count live from the operating record for this proposal's
  // own role, over a thirty-day window. Scoped to the one role on purpose — the
  // full affected-set computation belongs to the approval service, and reaching
  // for it here would couple the console read to the apply path.
  const since = new Date(
    platform.clock.now() - BLAST_RADIUS_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const role = await platform.roleStore.getRole(proposal.roleId);
  const [runCount, recent] = await Promise.all([
    platform.runs.countRuns({ roleId: proposal.roleId, createdAfter: since }),
    platform.runs.listRuns({ roleId: proposal.roleId, createdAfter: since, limit: 50 }),
  ]);
  const workflows = [...new Set(recent.map((run) => run.kind))].sort();
  return {
    roles: role ? [role.name] : [],
    workflows,
    runsInLastThirtyDays: runCount,
  };
}

async function evaluationViewFor(
  platform: Platform,
  evaluationId: Id<"evaluation">,
): Promise<EvaluationView | undefined> {
  const run = await platform.evaluations.getEvaluation(evaluationId);
  return run ? evaluationView(run) : undefined;
}

/** Map a proposal to the console's view model. */
export async function improvementProposalView(
  platform: Platform,
  proposal: Proposal,
): Promise<ImprovementProposalView> {
  const [radius, before, after] = await Promise.all([
    blastRadius(platform, proposal),
    proposal.evaluation
      ? evaluationViewFor(platform, proposal.evaluation.baselineRunId)
      : Promise.resolve(undefined),
    proposal.evaluation
      ? evaluationViewFor(platform, proposal.evaluation.candidateRunId)
      : Promise.resolve(undefined),
  ]);

  return {
    proposalId: proposal.id,
    kind: proposal.target.kind,
    title: titleFor(proposal),
    rationale: proposal.rationale,
    artifactKind: proposal.target.kind,
    artifactRef: proposal.target.id,
    before: renderArtifact(proposal.before),
    after: renderArtifact(proposal.after),
    evaluationBefore: before,
    evaluationAfter: after,
    // Percentage points, so the console renders "+3.0 pts" without deciding the
    // scale. Absent until the proposal has been measured.
    evaluationDelta:
      proposal.evaluation ? Number((proposal.evaluation.delta * 100).toFixed(1)) : undefined,
    blastRadius: radius,
    observationCount: proposal.observationIds.length,
    createdAt: proposal.createdAt,
    status: proposal.status,
  };
}

/** One page of proposals, honestly empty when nothing has been drafted. */
export async function improvementProposalsPage(
  platform: Platform,
  limit: number,
  offset: number,
): Promise<{
  readonly items: readonly ImprovementProposalView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}> {
  const proposals = await platform.proposals.listProposals({ limit, offset });
  const items = await Promise.all(
    proposals.map((proposal) => improvementProposalView(platform, proposal)),
  );
  return { items, total: items.length, limit, offset };
}
