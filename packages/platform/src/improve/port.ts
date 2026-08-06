import type { Id } from "../kernel/ids.js";
import type { ActorRef, IsoTimestamp, OperatingMode } from "../record/types.js";
import type { EvaluationRun } from "../roles/types.js";
import type {
  AppliedChange,
  ArtifactKind,
  ArtifactRecord,
  Observation,
  ObservationFilter,
  Proposal,
  ProposalFilter,
  ProposalPatch,
  ProposalStatus,
  QualitySample,
} from "./types.js";

/**
 * Persistence ports for the improvement loop.
 *
 * Four operations here cannot be done as a read followed by a write in the
 * caller, so they are expressed as single atomic operations and implemented as
 * such in both adapters.
 *
 *   `appendObservation` is idempotent on `idempotencyKey`. A console that
 *   retries, or two operators recording the same correction, must not double
 *   the frequency a cluster reports — frequency is what decides which failure
 *   gets a person's attention, so inflating it steers the queue.
 *
 *   `transitionProposal` is a compare-and-set on status. Two reviewers acting
 *   on the same proposal must not both win: the second would be deciding on a
 *   state the first has already changed.
 *
 *   `installArtifact` and `restoreArtifact` are compare-and-set on the head
 *   version. Applying over a state the approver never saw is the failure the
 *   snapshot exists to prevent, and read-then-write reintroduces it.
 *
 *   `recordApplication` is keyed by proposal. One application per proposal,
 *   enforced by the store and again by the primary key in the schema, so a
 *   proposal cannot be applied twice even if every check above it were
 *   bypassed.
 *
 * As everywhere else in this platform, a read that cannot be served raises
 * rather than returning empty. "This proposal has never been applied" and "we
 * cannot tell whether it has been applied" lead to opposite decisions.
 */

export interface AppendObservationResult {
  readonly observation: Observation;
  /**
   * False when an observation with this idempotency key already existed.
   *
   * The caller uses it to decide whether to write an audit entry: recording the
   * same correction twice in the chain would make the chain say it happened
   * twice.
   */
  readonly recorded: boolean;
}

export interface ObservationStore {
  appendObservation(observation: Observation): Promise<AppendObservationResult>;
  getObservation(id: Id<"observation">): Promise<Observation | null>;
  listObservations(filter?: ObservationFilter): Promise<readonly Observation[]>;
  countObservations(filter?: ObservationFilter): Promise<number>;
}

export interface ArtifactStore {
  /** The version the deployment reads now, or null when there is none. */
  head(kind: ArtifactKind, id: string): Promise<ArtifactRecord | null>;
  getArtifactVersion(
    kind: ArtifactKind,
    id: string,
    version: number,
  ): Promise<ArtifactRecord | null>;
  /** Every version ever installed, oldest first. History is never deleted. */
  listArtifactVersions(kind: ArtifactKind, id: string): Promise<readonly ArtifactRecord[]>;
  listHeads(kind?: ArtifactKind): Promise<readonly ArtifactRecord[]>;

  /**
   * Append a version and move the head to it, atomically.
   *
   * @returns `null` when `expectedHeadVersion` no longer matches what is
   *   stored, meaning something else changed this artifact and the caller's
   *   approver never saw the state it is about to write over.
   */
  installArtifact(input: {
    readonly artifact: ArtifactRecord;
    /** The head the caller believes is current; `undefined` means none. */
    readonly expectedHeadVersion: number | undefined;
  }): Promise<ArtifactRecord | null>;

  /**
   * Move the head back to a version already in the history, atomically.
   *
   * Deliberately not a delete. The version that is being rolled off stays in
   * the history, because "what was live between Tuesday and Thursday" is a
   * question an incident review asks.
   *
   * @returns `null` on a lost race, or when `toVersion` is not in the history.
   */
  restoreArtifact(input: {
    readonly kind: ArtifactKind;
    readonly id: string;
    readonly toVersion: number;
    readonly expectedHeadVersion: number;
    readonly at: IsoTimestamp;
    readonly by: ActorRef;
  }): Promise<ArtifactRecord | null>;
}

export interface ProposalStore {
  createProposal(proposal: Proposal): Promise<Proposal>;
  getProposal(id: Id<"proposal">): Promise<Proposal | null>;
  /** @throws {DeniedError} `record.unavailable` when it is absent. */
  requireProposal(id: Id<"proposal">): Promise<Proposal>;
  listProposals(filter?: ProposalFilter): Promise<readonly Proposal[]>;

  /**
   * Move a proposal between states, atomically.
   *
   * @returns `null` when the proposal is not in `expectedStatus`, so a second
   *   reviewer deciding on a stale view refuses rather than overwriting.
   */
  transitionProposal(input: {
    readonly id: Id<"proposal">;
    readonly expectedStatus: ProposalStatus;
    readonly nextStatus: ProposalStatus;
    readonly patch?: ProposalPatch | undefined;
  }): Promise<Proposal | null>;

  /** One application per proposal. A repeat of the identical write is a no-op. */
  recordApplication(application: AppliedChange): Promise<AppliedChange>;
  getApplication(proposalId: Id<"proposal">): Promise<AppliedChange | null>;
  listApplications(filter?: {
    readonly reverted?: boolean | undefined;
    readonly limit?: number | undefined;
  }): Promise<readonly AppliedChange[]>;

  /**
   * Mark an application reverted, atomically.
   *
   * @returns `null` when it was already reverted, which is how a double revert
   *   is detected rather than silently repeated.
   */
  markReverted(input: {
    readonly proposalId: Id<"proposal">;
    readonly revertedAt: IsoTimestamp;
    readonly revertedBy: ActorRef;
    readonly reason: string;
  }): Promise<AppliedChange | null>;

  /** Post-change measurements. Append-only; a sample is evidence. */
  recordQualitySample(sample: QualitySample): Promise<QualitySample>;
  listQualitySamples(proposalId: Id<"proposal">): Promise<readonly QualitySample[]>;
}

export interface TrialRequest {
  readonly proposal: Proposal;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  /** The operating-record run the trial's model calls are charged to. */
  readonly runId: Id<"run">;
  readonly correlationId?: string | undefined;
}

export interface TrialResult {
  /** The affected role measured as it stands today. */
  readonly baseline: EvaluationRun;
  /** The same role measured with the proposal in effect and nothing changed. */
  readonly candidate: EvaluationRun;
}

/**
 * How a proposal is measured without being applied.
 *
 * The measurement itself belongs to `roles/evaluation.ts` — it owns the golden
 * sets, the scoring, and the harness. What belongs here is the *gate*: whether
 * a measured change is good enough to put in front of a person. Separating them
 * keeps this module from reimplementing an evaluation harness, and keeps the
 * harness from knowing anything about approvals.
 *
 * An implementation must:
 *
 *   - **change nothing.** The candidate is measured with the proposal in
 *     effect for the duration of the trial and no longer. An implementation
 *     that applied the change to measure it would be the autonomous
 *     application this whole module exists to prevent.
 *   - **measure both runs against the same golden set version.** `evaluate.ts`
 *     checks this rather than trusting it, because measuring the candidate
 *     against an easier set is the cheapest way to manufacture an improvement.
 *   - **run in a mode with no external effect.** A trial is an experiment on
 *     the platform, not on owners.
 */
export interface ProposalTrial {
  measure(request: TrialRequest): Promise<TrialResult>;
}
