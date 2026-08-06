import { InvalidInputError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";
import type { GoldenCase } from "../roles/types.js";

/**
 * The improvement loop: the shapes.
 *
 * The loop exists to make one sentence true — *the platform gets measurably
 * better over time, and never changes its own behaviour on its own authority*.
 * Both halves are encoded here rather than left to the services that use these
 * types, because a type that permits the wrong shape is a control that depends
 * on everybody remembering.
 *
 * *A proposal is inert data.* `Proposal` has no method, carries no callback,
 * and names no executor. It is a description of a change that a person may
 * choose to make. `propose.ts` freezes what it returns; a test walks the object
 * and fails if any property is callable. There is nothing on a proposal to
 * invoke, so "the loop applied it itself" is not a bug that can be introduced
 * by forgetting a check — it would need a new code path with a person's name on
 * the commit.
 *
 * *The loop changes declarative artifacts, never source.* `ArtifactKind` is a
 * closed list, and it names four things the deployment already reads as
 * configuration plus one that is applied through the roles module's own
 * protected path. There is no kind that means "a file", and `artifacts.ts`
 * refuses a target whose identifier looks like a path.
 *
 * *Artifact content is flat and primitive.* `ArtifactContent` cannot nest.
 * That is not tidiness: an artifact that could hold arbitrary structure is
 * somewhere to put a prompt, and prompts belong in version control where a
 * reviewer reads the diff. A binding names the prompt artifact; it never
 * carries its text.
 *
 * Timestamps are ISO-8601 UTC strings, as everywhere else in the platform, and
 * payloads appear only as digests.
 */

/**
 * Where an observation came from.
 *
 * These five are the whole of what the loop learns from, and each one is a
 * moment where a human disagreed with the platform in a way the operating
 * record already knows about. Nothing here is inferred from a model's opinion
 * of its own output.
 */
export const OBSERVATION_KINDS = [
  /** A person changed what the platform produced before it was used. */
  "human_correction",
  /** An approver refused a parked action outright. */
  "proposal_rejected",
  /** An approver granted the action but altered what it would do. */
  "approval_override",
  /** Work that was meant to complete came back to a human instead. */
  "escalation",
  /** A shadow-mode run reached a different answer than the human did. */
  "shadow_disagreement",
] as const;

export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

/**
 * One structured disagreement, tied to the run that produced it.
 *
 * `runId` is required. An observation with no run is an anecdote: there is no
 * way to check what the platform was actually asked, what it answered, what it
 * cost, or which role and version produced it — which is every input the rest
 * of the loop reasons from.
 *
 * `beforeDigest` and `afterDigest` fingerprint what the platform produced and
 * what the human replaced it with. The texts themselves stay in the systems
 * whose retention rules govern them; this record proves the linkage.
 */
export interface Observation {
  readonly id: Id<"observation">;
  readonly kind: ObservationKind;
  readonly runId: Id<"run">;
  readonly stepId?: Id<"step"> | undefined;
  readonly roleId?: Id<"role"> | undefined;
  readonly roleVersion?: number | undefined;
  /** The run's `kind`, carried so clustering can name the affected workflow. */
  readonly workflowKind?: string | undefined;
  /**
   * Machine-readable failure signature, e.g. `deadline.wrong_jurisdiction`.
   *
   * Chosen by the person or the code recording the observation, from a
   * vocabulary the operator maintains. Clustering groups on this, so a free-text
   * summary would produce one cluster per typist.
   */
  readonly signature: string;
  /** One line for the operator reading the cluster. Redacted before storage. */
  readonly note: string;
  readonly observedBy: ActorRef;
  readonly recordedAt: IsoTimestamp;
  /** Fingerprint of what the platform produced. */
  readonly beforeDigest?: Digest | undefined;
  /** Fingerprint of what the human replaced it with. */
  readonly afterDigest?: Digest | undefined;
  /** Human minutes the correction cost. Half the ranking signal. */
  readonly correctionMinutes: number;
  /** Money already spent on the run that produced this. The other half. */
  readonly costUsd: number;
  /** Opaque references. Never owner personal data. */
  readonly subject: Readonly<Record<string, string>>;
  /**
   * Deduplication key.
   *
   * A console that retries a submission, or two operators recording the same
   * correction, must not double the frequency a cluster reports — the
   * frequency is what decides which failure gets a person's attention.
   */
  readonly idempotencyKey: string;
}

export type NewObservation = Omit<Observation, "id" | "recordedAt"> & {
  readonly id?: Id<"observation">;
  readonly recordedAt?: IsoTimestamp;
};

export interface ObservationFilter {
  readonly kind?: readonly ObservationKind[] | undefined;
  readonly runId?: Id<"run"> | undefined;
  readonly roleId?: Id<"role"> | undefined;
  readonly signature?: string | undefined;
  readonly recordedAfter?: IsoTimestamp | undefined;
  readonly recordedBefore?: IsoTimestamp | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** One observation, rendered as the evidence line an operator reads. */
export interface ClusterEvidence {
  readonly observationId: Id<"observation">;
  readonly runId: Id<"run">;
  readonly kind: ObservationKind;
  readonly recordedAt: IsoTimestamp;
  readonly note: string;
  readonly beforeDigest?: Digest | undefined;
  readonly afterDigest?: Digest | undefined;
}

/**
 * A recurring failure pattern with its evidence attached.
 *
 * Deliberately not a stored entity. A cluster is a view over observations,
 * recomputed from them on demand, so it cannot drift from the evidence it
 * claims to summarise — which is what a stored cluster does the first time
 * somebody purges an observation for a retention reason.
 *
 * `key` is derived from the role and the signature rather than generated, for
 * the same reason: two computations over the same observations produce the same
 * clusters with the same keys, so an operator's link to a cluster still works
 * tomorrow.
 */
export interface FailureCluster {
  readonly key: string;
  readonly signature: string;
  readonly roleId?: Id<"role"> | undefined;
  readonly kinds: readonly ObservationKind[];
  readonly workflowKinds: readonly string[];
  readonly count: number;
  /**
   * Runs of the same role in the same window: the denominator behind `rate`.
   *
   * Zero when the caller supplied no denominator, in which case `rate` is 0 and
   * the cluster is ranked on frequency and cost alone. A rate computed against
   * a guessed denominator would read as measurement and be invention.
   */
  readonly comparableRuns: number;
  /** `count / comparableRuns`, in [0, 1]. The "12% of cases" figure. */
  readonly rate: number;
  readonly humanMinutes: number;
  readonly costUsd: number;
  readonly firstSeenAt: IsoTimestamp;
  readonly lastSeenAt: IsoTimestamp;
  /** Ranking score. Higher is worse. See `cluster.ts` for its construction. */
  readonly score: number;
  /** 1-based position in the ranked list. */
  readonly rank: number;
  readonly evidence: readonly ClusterEvidence[];
  /** One sentence an operator reads without knowing the schema. */
  readonly summary: string;
}

/**
 * The declarative artifacts the loop may change.
 *
 * A closed list, and the whole of the "no self-modifying code" boundary that
 * can be stated as data. Every entry is something the deployment already reads
 * as configuration or ground truth. None of them is a file.
 *
 *   `prompt_binding`   which committed prompt artifact and version a role uses.
 *                      The prompt text lives in version control; this names it.
 *   `routing_rule`     which role or queue a kind of work goes to.
 *   `guardrail_rule`   a declarative bound: a threshold, a refusal condition.
 *   `knowledge_gap`    a hole in a governed corpus, recorded for a curator.
 *   `evaluation_case`  additions to a curated golden set. Applied through the
 *                      roles module's protected path, never in place.
 */
export const ARTIFACT_KINDS = [
  "prompt_binding",
  "routing_rule",
  "guardrail_rule",
  "knowledge_gap",
  "evaluation_case",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** A value an artifact may hold. Flat and primitive on purpose. */
export type ArtifactValue = string | number | boolean;

/**
 * The body of a declarative artifact.
 *
 * Cannot nest. An artifact that could hold arbitrary structure is somewhere to
 * put a prompt, and a prompt in a database is a change to what the system
 * decides that no reviewer ever saw.
 */
export type ArtifactContent = Readonly<Record<string, ArtifactValue>>;

/** What the loop proposes to change, named rather than located. */
export interface ArtifactTarget {
  readonly kind: ArtifactKind;
  /** Stable dotted lower_snake_case identifier. Never a path, never a filename. */
  readonly id: string;
}

/** One version of a governed artifact. */
export interface ArtifactState {
  readonly kind: ArtifactKind;
  readonly id: string;
  /** 1-based. Version 0 is reserved for "this artifact does not exist yet". */
  readonly version: number;
  readonly content: ArtifactContent;
  /** Fingerprint of `{kind, id, version, content}`. Binds approvals to it. */
  readonly digest: Digest;
}

/** A stored artifact version, with the decision that put it there. */
export interface ArtifactRecord extends ArtifactState {
  readonly recordedAt: IsoTimestamp;
  readonly recordedBy: ActorRef;
  /** The proposal that installed it, when it came from the loop. */
  readonly proposalId?: Id<"proposal"> | undefined;
  /** The human decision that authorised it. Absent only for seeded v1. */
  readonly approvalId?: Id<"approval"> | undefined;
}

/**
 * Where a proposal sits.
 *
 *   `drafted`    Inert description of a change. Nobody has measured it.
 *   `withheld`   Measured, and it did not improve quality. Never offered.
 *   `offered`    Measured, it improves quality, a human may now see it.
 *   `rejected`   A human said no.
 *   `approved`   A human said yes and an approval was granted.
 *   `applied`    The change is live.
 *   `reverted`   It was live and has been rolled back.
 *
 * There is no status meaning "applying itself", and no transition into
 * `applied` that does not pass through `approved` with an approval id.
 */
export const PROPOSAL_STATUSES = [
  "drafted",
  "withheld",
  "offered",
  "rejected",
  "approved",
  "applied",
  "reverted",
] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * The state machine, enforced by both store adapters.
 *
 * Written down as data rather than as a chain of `if`s in the services,
 * because the interesting entries are the empty ones. A `rejected` proposal
 * cannot be revived — somebody said no, and reviving it would quietly reuse
 * their decision on a change they can no longer see. An `applied` one cannot go
 * back to `approved` and be applied twice. A `drafted` one cannot jump straight
 * to `applied`, whatever a caller passes.
 */
export const LEGAL_PROPOSAL_TRANSITIONS: Readonly<
  Record<ProposalStatus, readonly ProposalStatus[]>
> = Object.freeze({
  drafted: ["offered", "withheld"],
  // Re-measurable: the world changes, and a proposal withheld in March may be
  // an improvement in June.
  withheld: ["offered", "withheld"],
  offered: ["approved", "rejected", "offered", "withheld"],
  approved: ["applied"],
  applied: ["reverted"],
  rejected: [],
  reverted: [],
});

/**
 * Refuse a move that is not in the state machine.
 *
 * Lives here beside the table rather than in an adapter, because both adapters
 * apply it and the rule is a property of the domain rather than of either
 * store.
 *
 * @throws {InvalidInputError}
 */
export function assertTransition(from: ProposalStatus, to: ProposalStatus): void {
  const allowed = LEGAL_PROPOSAL_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidInputError(
      `A proposal cannot move from ${from} to ${to}. Permitted from ${from}: ${allowed && allowed.length > 0 ? allowed.join(", ") : "nothing — it is a final state"}.`,
      "status",
    );
  }
}

/**
 * What measuring the proposal established.
 *
 * Produced before any human sees a recommendation. `offered: false` means the
 * change did not improve measured quality and the queue never shows it —
 * a proposal that cannot demonstrate an improvement is not a recommendation,
 * it is an opinion.
 */
export interface ProposalEvaluation {
  readonly baselineRunId: Id<"evaluation">;
  readonly candidateRunId: Id<"evaluation">;
  readonly goldenSetId: string;
  readonly goldenSetVersion: number;
  /** Both runs must cite this. Different cases, different measurement. */
  readonly goldenSetDigest: Digest;
  readonly caseCount: number;
  readonly baselineAccuracy: number;
  readonly candidateAccuracy: number;
  /** `candidateAccuracy - baselineAccuracy`. Negative means it got worse. */
  readonly delta: number;
  /** Cases that passed before and do not pass now. Any at all withholds it. */
  readonly regressedCaseIds: readonly string[];
  /** Cases that failed before and pass now. What the change bought. */
  readonly improvedCaseIds: readonly string[];
  readonly offered: boolean;
  /** Why it was withheld, in a sentence. Empty when it was offered. */
  readonly withheldReason: string;
  readonly evaluatedAt: IsoTimestamp;
}

/**
 * What this change would reach, computed from the operating record.
 *
 * Not an estimate and not a category. Every number here comes from counting
 * rows an operator could count themselves.
 */
export interface BlastRadius {
  readonly roleIds: readonly Id<"role">[];
  readonly roleNames: readonly string[];
  /** Distinct run kinds — the workflows — this change would have touched. */
  readonly workflowKinds: readonly string[];
  readonly windowDays: number;
  /** Runs in the window that would have gone through the changed artifact. */
  readonly runCount: number;
  /** Runs still in flight right now. These are the ones that change mid-air. */
  readonly openRunCount: number;
  /** A handful of run ids so a reviewer can open one and look. */
  readonly sampleRunIds: readonly Id<"run">[];
  readonly computedAt: IsoTimestamp;
}

/** The human decision, recorded on the proposal. */
export interface ProposalDecision {
  readonly approvalId: Id<"approval">;
  readonly decision: "granted" | "rejected";
  readonly decidedBy: ActorRef;
  readonly decidedAt: IsoTimestamp;
  readonly note: string;
  /** What the approver was shown, kept so the decision stays explicable. */
  readonly blastRadius: BlastRadius;
}

/**
 * A candidate change. **Inert data.**
 *
 * There is no `apply`, no `execute`, no `run`, and no handle to anything that
 * has one. Applying this requires `ImprovementApplier.apply`, an approval id,
 * and a trip through the authorization chokepoint.
 */
export interface Proposal {
  readonly id: Id<"proposal">;
  readonly status: ProposalStatus;
  readonly target: ArtifactTarget;
  /** The role whose measured quality this change is judged by. */
  readonly roleId: Id<"role">;
  readonly roleVersion: number;
  /** The cluster this came from, so the evidence is one lookup away. */
  readonly clusterKey: string;
  readonly observationIds: readonly Id<"observation">[];
  /** Why, in a sentence an approver will actually read. */
  readonly rationale: string;
  readonly before: ArtifactState;
  readonly after: ArtifactState;
  /**
   * Cases this proposal would ADD to a golden set.
   *
   * Only ever additions. `roles/evaluation.ts` refuses a proposed set that
   * deletes, relabels, weakens, or renames an existing case, and both the
   * drafting path and the applying path run that guard.
   */
  readonly addedCases?: readonly GoldenCase[] | undefined;
  /** Fingerprint of the change. Recomputed on load; a tampered row fails. */
  readonly digest: Digest;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: ActorRef;
  readonly evaluation?: ProposalEvaluation | undefined;
  readonly decision?: ProposalDecision | undefined;
}

export type ProposalPatch = {
  readonly evaluation?: ProposalEvaluation | undefined;
  readonly decision?: ProposalDecision | undefined;
};

export interface ProposalFilter {
  readonly status?: readonly ProposalStatus[] | undefined;
  readonly roleId?: Id<"role"> | undefined;
  readonly targetKind?: ArtifactKind | undefined;
  readonly targetId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * An applied change, and everything needed to undo it in one action.
 *
 * Keyed by `proposalId`: one application per proposal, enforced by the store
 * and by the primary key in the schema. Even if every check above it were
 * bypassed, a proposal cannot be applied twice.
 */
export interface AppliedChange {
  readonly proposalId: Id<"proposal">;
  /**
   * The human decision this was applied on.
   *
   * Never optional, never empty. A row here without one would be the platform
   * having changed its own behaviour, and the schema refuses it.
   */
  readonly approvalId: Id<"approval">;
  readonly target: ArtifactTarget;
  /** The state to restore. This is what makes revert one action. */
  readonly snapshot: ArtifactState;
  /** The state that is live now. */
  readonly installed: ArtifactState;
  /**
   * Whether this kind of change can be rolled back.
   *
   * False for `evaluation_case`: the cases stay. Removing an expected outcome
   * from the ground truth of record is the one change this platform never
   * makes, and a revert that deleted cases would be exactly that change under
   * another name.
   */
  readonly revertible: boolean;
  readonly appliedAt: IsoTimestamp;
  readonly appliedBy: ActorRef;
  readonly runId: Id<"run">;
  readonly revertedAt?: IsoTimestamp | undefined;
  readonly revertedBy?: ActorRef | undefined;
  readonly revertReason?: string | undefined;
}

/** One post-change measurement of an applied proposal. */
export interface QualitySample {
  readonly proposalId: Id<"proposal">;
  readonly evaluationRunId: Id<"evaluation">;
  readonly goldenSetDigest: Digest;
  readonly accuracy: number;
  readonly caseCount: number;
  /** Cases that passed in the pre-change baseline and do not pass now. */
  readonly regressedCaseIds: readonly string[];
  readonly observedAt: IsoTimestamp;
}

/**
 * Corrections per run, before and after the change.
 *
 * The evaluation samples measure the golden set; this measures the world. Both
 * matter, and they fail differently: a golden set can stay green while
 * operators quietly correct twice as much work.
 */
export interface CorrectionRate {
  /** False when too little time has passed for the comparison to mean anything. */
  readonly comparable: boolean;
  readonly windowMs: number;
  readonly beforeCorrections: number;
  readonly beforeRuns: number;
  readonly beforeRate: number;
  readonly afterCorrections: number;
  readonly afterRuns: number;
  readonly afterRate: number;
}

/**
 * The offer of a revert.
 *
 * Data, not a callback. The watch does not roll anything back: an automatic
 * rollback is still the platform changing its behaviour on its own authority,
 * and ADR 0011 refused exactly that trade. What it does is put the one action
 * that undoes the change in front of a person, with the numbers that justify
 * it.
 */
export interface RevertOffer {
  readonly proposalId: Id<"proposal">;
  /** The action an operator performs. Registered, gated, and audited. */
  readonly action: string;
  readonly available: boolean;
  /** Why it is not available, when it is not. */
  readonly unavailableReason: string;
  readonly restoresVersion: number;
}

export interface WatchReport {
  readonly proposalId: Id<"proposal">;
  readonly baselineAccuracy: number;
  readonly latestAccuracy: number;
  readonly delta: number;
  readonly sampleCount: number;
  readonly regressed: boolean;
  readonly regressedCaseIds: readonly string[];
  readonly corrections: CorrectionRate;
  /** Machine-readable reasons the watch is unhappy. Empty when it is not. */
  readonly reasons: readonly string[];
  readonly revert: RevertOffer;
  readonly assessedAt: IsoTimestamp;
}
