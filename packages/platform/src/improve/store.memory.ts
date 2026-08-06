import { canonicalJson } from "../kernel/canonical.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { isDigest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";
import type { MemoryDb } from "../store/db.js";
import type {
  AppendObservationResult,
  ArtifactStore,
  ObservationStore,
  ProposalStore,
} from "./port.js";
import {
  ARTIFACT_KINDS,
  OBSERVATION_KINDS,
  PROPOSAL_STATUSES,
  assertTransition,
  type AppliedChange,
  type ArtifactKind,
  type ArtifactRecord,
  type Observation,
  type ObservationFilter,
  type Proposal,
  type ProposalFilter,
  type ProposalPatch,
  type ProposalStatus,
  type QualitySample,
} from "./types.js";

/**
 * In-memory improvement-loop storage.
 *
 * Held to the same contract as the Postgres adapter, including the parts that
 * are inconvenient to fake. The validation below duplicates the CHECK
 * constraints in `migrations.ts` deliberately: a fake that is more forgiving
 * than the real thing lets a test pass on code Postgres would reject, and the
 * constraints being duplicated here are the ones that carry the product's
 * central claim.
 *
 * The locks are named per artifact and per proposal rather than one global one,
 * because that is what Postgres does with row locking, and a fake that
 * serialised everything would hide a race the real store would expose.
 *
 * Two divergences, stated rather than hidden. Postgres carries foreign keys
 * from `improvement_observation.run_id` and `improvement_application.run_id` to
 * `run`, and from `improvement_proposal.role_id` to `agent_role`; this adapter
 * does not check them, because reaching into another module's in-memory tables
 * to imitate a constraint would couple this store to their table names. In
 * practice the services read the run and the role before writing, so the paths
 * that matter are covered; a test that writes a row directly with an invented
 * run id will pass here and fail against Postgres.
 */

const OBSERVATIONS = "improvement_observation";
const ARTIFACTS = "improvement_artifact";
const ARTIFACT_HEADS = "improvement_artifact_head";
const PROPOSALS = "improvement_proposal";
const APPLICATIONS = "improvement_application";
const SAMPLES = "improvement_quality_sample";

interface HeadRow {
  readonly kind: ArtifactKind;
  readonly id: string;
  readonly version: number;
  readonly updatedAt: IsoTimestamp;
  readonly updatedBy: ActorRef;
}

function artifactKey(kind: string, id: string, version: number): string {
  return `${kind}#${id}#${version}`;
}

function headKey(kind: string, id: string): string {
  return `${kind}#${id}`;
}

function sampleKey(proposalId: string, evaluationRunId: string): string {
  return `${proposalId}#${evaluationRunId}`;
}

export class MemoryObservationStore implements ObservationStore {
  constructor(private readonly db: MemoryDb) {}

  async appendObservation(observation: Observation): Promise<AppendObservationResult> {
    assertObservationRow(observation);

    // One lock for the whole table: the uniqueness rule is on the idempotency
    // key, which is cross-row, so a per-observation lock would not serialise
    // the writes that can actually collide.
    return this.db.withLock("improve:observations", async () => {
      const table = this.db.table<Observation>(OBSERVATIONS);

      for (const existing of table.values()) {
        if (existing.idempotencyKey === observation.idempotencyKey) {
          // The deduplication rule. A retried submission returns what is
          // already recorded rather than doubling a cluster's count.
          return { observation: structuredClone(existing), recorded: false };
        }
      }

      if (table.has(observation.id)) {
        throw new InvalidInputError(`Observation ${observation.id} already exists.`, "id");
      }

      table.set(observation.id, structuredClone(observation));
      return { observation: structuredClone(observation), recorded: true };
    });
  }

  async getObservation(id: Id<"observation">): Promise<Observation | null> {
    const found = this.db.table<Observation>(OBSERVATIONS).get(id);
    return found ? structuredClone(found) : null;
  }

  async listObservations(filter: ObservationFilter = {}): Promise<readonly Observation[]> {
    const rows = this.db.rows<Observation>(OBSERVATIONS);
    const ordinals = new Map(rows.map((row, index) => [row.id, index]));
    const matched = rows.filter((row) => matchesObservationFilter(row, filter));

    // Oldest first, with insertion order as the tiebreak. Under a fixed clock
    // every observation in a test shares a `recordedAt`, so without the
    // tiebreak the order would depend on sort stability rather than anything
    // real — and clustering reads this order.
    matched.sort((left, right) => {
      if (left.recordedAt !== right.recordedAt) return left.recordedAt < right.recordedAt ? -1 : 1;
      return (ordinals.get(left.id) ?? 0) - (ordinals.get(right.id) ?? 0);
    });

    const from = filter.offset ?? 0;
    const to = filter.limit === undefined ? matched.length : from + filter.limit;
    return matched.slice(from, to).map((row) => structuredClone(row));
  }

  async countObservations(filter: ObservationFilter = {}): Promise<number> {
    // Deliberately ignores limit and offset, matching the operating record: a
    // count that respected the page size could never tell a caller how many
    // pages there are.
    return this.db
      .rows<Observation>(OBSERVATIONS)
      .filter((row) => matchesObservationFilter(row, filter)).length;
  }
}

export class MemoryArtifactStore implements ArtifactStore {
  constructor(private readonly db: MemoryDb) {}

  async head(kind: ArtifactKind, id: string): Promise<ArtifactRecord | null> {
    const pointer = this.db.table<HeadRow>(ARTIFACT_HEADS).get(headKey(kind, id));
    if (!pointer) return null;
    return this.getArtifactVersion(kind, id, pointer.version);
  }

  async getArtifactVersion(
    kind: ArtifactKind,
    id: string,
    version: number,
  ): Promise<ArtifactRecord | null> {
    const found = this.db.table<ArtifactRecord>(ARTIFACTS).get(artifactKey(kind, id, version));
    return found ? structuredClone(found) : null;
  }

  async listArtifactVersions(
    kind: ArtifactKind,
    id: string,
  ): Promise<readonly ArtifactRecord[]> {
    return this.db
      .rows<ArtifactRecord>(ARTIFACTS)
      .filter((row) => row.kind === kind && row.id === id)
      .sort((left, right) => left.version - right.version)
      .map((row) => structuredClone(row));
  }

  async listHeads(kind?: ArtifactKind): Promise<readonly ArtifactRecord[]> {
    const heads: ArtifactRecord[] = [];
    for (const pointer of this.db.rows<HeadRow>(ARTIFACT_HEADS)) {
      if (kind !== undefined && pointer.kind !== kind) continue;
      const found = await this.getArtifactVersion(pointer.kind, pointer.id, pointer.version);
      if (found) heads.push(found);
    }
    return heads.sort((left, right) =>
      left.kind !== right.kind
        ? left.kind < right.kind
          ? -1
          : 1
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
    );
  }

  async installArtifact(input: {
    readonly artifact: ArtifactRecord;
    readonly expectedHeadVersion: number | undefined;
  }): Promise<ArtifactRecord | null> {
    const artifact = input.artifact;
    assertArtifactRow(artifact);

    return this.db.withLock(`improve:artifact:${artifact.kind}:${artifact.id}`, async () => {
      const heads = this.db.table<HeadRow>(ARTIFACT_HEADS);
      const versions = this.db.table<ArtifactRecord>(ARTIFACTS);
      const pointer = heads.get(headKey(artifact.kind, artifact.id));

      // Compare-and-set. A change approved against one state must not land on
      // a different one: the loser's approver never saw what is there now.
      if (pointer?.version !== input.expectedHeadVersion) return null;

      const expected = (pointer?.version ?? 0) + 1;
      if (artifact.version !== expected) {
        throw new InvalidInputError(
          `Artifact "${artifact.id}" is at v${pointer?.version ?? 0}; the next version is ${expected}, not ${artifact.version}. History is append-only and contiguous.`,
          "version",
        );
      }

      versions.set(
        artifactKey(artifact.kind, artifact.id, artifact.version),
        structuredClone(artifact),
      );
      heads.set(headKey(artifact.kind, artifact.id), {
        kind: artifact.kind,
        id: artifact.id,
        version: artifact.version,
        updatedAt: artifact.recordedAt,
        updatedBy: structuredClone(artifact.recordedBy),
      });

      return structuredClone(artifact);
    });
  }

  async restoreArtifact(input: {
    readonly kind: ArtifactKind;
    readonly id: string;
    readonly toVersion: number;
    readonly expectedHeadVersion: number;
    readonly at: IsoTimestamp;
    readonly by: ActorRef;
  }): Promise<ArtifactRecord | null> {
    assertIsoUtc("at", input.at);

    return this.db.withLock(`improve:artifact:${input.kind}:${input.id}`, async () => {
      const heads = this.db.table<HeadRow>(ARTIFACT_HEADS);
      const pointer = heads.get(headKey(input.kind, input.id));
      if (!pointer || pointer.version !== input.expectedHeadVersion) return null;

      const target = this.db
        .table<ArtifactRecord>(ARTIFACTS)
        .get(artifactKey(input.kind, input.id, input.toVersion));
      if (!target) return null;

      // The rolled-off version stays in the history. "What was live between
      // Tuesday and Thursday" is the first question an incident review asks.
      heads.set(headKey(input.kind, input.id), {
        kind: input.kind,
        id: input.id,
        version: input.toVersion,
        updatedAt: input.at,
        updatedBy: structuredClone(input.by),
      });

      return structuredClone(target);
    });
  }
}

export class MemoryProposalStore implements ProposalStore {
  constructor(private readonly db: MemoryDb) {}

  async createProposal(proposal: Proposal): Promise<Proposal> {
    assertProposalRow(proposal);

    return this.db.withLock(`improve:proposal:${proposal.id}`, async () => {
      const table = this.db.table<Proposal>(PROPOSALS);
      if (table.has(proposal.id)) {
        throw new InvalidInputError(`Proposal ${proposal.id} already exists.`, "id");
      }
      table.set(proposal.id, structuredClone(proposal));
      return structuredClone(proposal);
    });
  }

  async getProposal(id: Id<"proposal">): Promise<Proposal | null> {
    const found = this.db.table<Proposal>(PROPOSALS).get(id);
    return found ? structuredClone(found) : null;
  }

  async requireProposal(id: Id<"proposal">): Promise<Proposal> {
    const found = await this.getProposal(id);
    if (!found) {
      // Refused rather than returned empty. "This proposal was never applied"
      // and "we cannot tell whether it was applied" lead to opposite decisions.
      throw new DeniedError("record.unavailable", `Proposal ${id} is not in the record.`, {
        proposalId: id,
      });
    }
    return found;
  }

  async listProposals(filter: ProposalFilter = {}): Promise<readonly Proposal[]> {
    const rows = this.db.rows<Proposal>(PROPOSALS);
    const ordinals = new Map(rows.map((row, index) => [row.id, index]));
    const matched = rows.filter((row) => {
      if (filter.status && !filter.status.includes(row.status)) return false;
      if (filter.roleId !== undefined && row.roleId !== filter.roleId) return false;
      if (filter.targetKind !== undefined && row.target.kind !== filter.targetKind) return false;
      if (filter.targetId !== undefined && row.target.id !== filter.targetId) return false;
      return true;
    });

    matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
      return (ordinals.get(right.id) ?? 0) - (ordinals.get(left.id) ?? 0);
    });

    const from = filter.offset ?? 0;
    const to = filter.limit === undefined ? matched.length : from + filter.limit;
    return matched.slice(from, to).map((row) => structuredClone(row));
  }

  async transitionProposal(input: {
    readonly id: Id<"proposal">;
    readonly expectedStatus: ProposalStatus;
    readonly nextStatus: ProposalStatus;
    readonly patch?: ProposalPatch | undefined;
  }): Promise<Proposal | null> {
    assertTransition(input.expectedStatus, input.nextStatus);

    return this.db.withLock(`improve:proposal:${input.id}`, async () => {
      const table = this.db.table<Proposal>(PROPOSALS);
      const current = table.get(input.id);
      if (!current) {
        throw new DeniedError(
          "record.unavailable",
          `Proposal ${input.id} is not in the record.`,
          { proposalId: input.id },
        );
      }

      // Compare-and-set on the status, so a second reviewer acting on a stale
      // view refuses rather than overwriting the first one's decision.
      if (current.status !== input.expectedStatus) return null;

      const next: Proposal = {
        ...current,
        status: input.nextStatus,
        evaluation: input.patch?.evaluation ?? current.evaluation,
        decision: input.patch?.decision ?? current.decision,
      };
      assertProposalRow(next);
      table.set(input.id, structuredClone(next));
      return structuredClone(next);
    });
  }

  async recordApplication(application: AppliedChange): Promise<AppliedChange> {
    assertApplicationRow(application);

    return this.db.withLock(`improve:application:${application.proposalId}`, async () => {
      const table = this.db.table<AppliedChange>(APPLICATIONS);
      const existing = table.get(application.proposalId);
      if (existing) {
        // A repeat of the identical write is the crash-and-recover path. A
        // repeat with different content is a second application of the same
        // proposal, which is the thing this table's key exists to prevent.
        if (canonicalJson(existing) === canonicalJson(application)) {
          return structuredClone(existing);
        }
        throw new DeniedError(
          "record.unavailable",
          `Proposal ${application.proposalId} has already been applied. A change is applied once; to change the artifact again, propose the next change against the state that is live now.`,
          { proposalId: application.proposalId },
        );
      }
      table.set(application.proposalId, structuredClone(application));
      return structuredClone(application);
    });
  }

  async getApplication(proposalId: Id<"proposal">): Promise<AppliedChange | null> {
    const found = this.db.table<AppliedChange>(APPLICATIONS).get(proposalId);
    return found ? structuredClone(found) : null;
  }

  async listApplications(
    filter: { readonly reverted?: boolean | undefined; readonly limit?: number | undefined } = {},
  ): Promise<readonly AppliedChange[]> {
    const rows = this.db.rows<AppliedChange>(APPLICATIONS);
    const ordinals = new Map(rows.map((row, index) => [row.proposalId, index]));
    const matched = rows.filter((row) => {
      if (filter.reverted === undefined) return true;
      return filter.reverted ? row.revertedAt !== undefined : row.revertedAt === undefined;
    });

    matched.sort((left, right) => {
      if (left.appliedAt !== right.appliedAt) return left.appliedAt < right.appliedAt ? 1 : -1;
      return (ordinals.get(right.proposalId) ?? 0) - (ordinals.get(left.proposalId) ?? 0);
    });

    return matched
      .slice(0, filter.limit ?? matched.length)
      .map((row) => structuredClone(row));
  }

  async markReverted(input: {
    readonly proposalId: Id<"proposal">;
    readonly revertedAt: IsoTimestamp;
    readonly revertedBy: ActorRef;
    readonly reason: string;
  }): Promise<AppliedChange | null> {
    assertIsoUtc("revertedAt", input.revertedAt);
    if (input.reason.trim().length === 0) {
      throw new InvalidInputError("A revert needs a reason.", "reason");
    }

    return this.db.withLock(`improve:application:${input.proposalId}`, async () => {
      const table = this.db.table<AppliedChange>(APPLICATIONS);
      const current = table.get(input.proposalId);
      if (!current) return null;
      // Compare-and-set on "not yet reverted". A second revert would otherwise
      // roll back whatever had been applied since.
      if (current.revertedAt !== undefined) return null;
      if (!current.revertible) {
        throw new DeniedError(
          "improvement.protected_case_weakened",
          `The change applied for proposal ${input.proposalId} is not revertible.`,
          { proposalId: input.proposalId },
        );
      }

      const next: AppliedChange = {
        ...current,
        revertedAt: input.revertedAt,
        revertedBy: input.revertedBy,
        revertReason: input.reason,
      };
      table.set(input.proposalId, structuredClone(next));
      return structuredClone(next);
    });
  }

  async recordQualitySample(sample: QualitySample): Promise<QualitySample> {
    assertIsoUtc("observedAt", sample.observedAt);
    if (sample.accuracy < 0 || sample.accuracy > 1) {
      throw new InvalidInputError(
        `Quality sample for proposal ${sample.proposalId} has an accuracy outside [0, 1].`,
        "accuracy",
      );
    }
    if (!isDigest(sample.goldenSetDigest)) {
      throw new InvalidInputError(
        `Quality sample for proposal ${sample.proposalId} needs the digest of the cases it measured.`,
        "goldenSetDigest",
      );
    }

    const key = sampleKey(sample.proposalId, sample.evaluationRunId);
    return this.db.withLock(`improve:sample:${key}`, async () => {
      const table = this.db.table<QualitySample>(SAMPLES);
      const existing = table.get(key);
      if (existing) {
        if (canonicalJson(existing) === canonicalJson(sample)) return structuredClone(existing);
        throw new DeniedError(
          "record.unavailable",
          `Evaluation run ${sample.evaluationRunId} is already recorded against proposal ${sample.proposalId} with different numbers. A measurement whose figures can be rewritten afterwards is not evidence.`,
          { proposalId: sample.proposalId, evaluationRunId: sample.evaluationRunId },
        );
      }
      table.set(key, structuredClone(sample));
      return structuredClone(sample);
    });
  }

  async listQualitySamples(proposalId: Id<"proposal">): Promise<readonly QualitySample[]> {
    const rows = this.db.rows<QualitySample>(SAMPLES);
    const ordinals = new Map(
      rows.map((row, index) => [sampleKey(row.proposalId, row.evaluationRunId), index]),
    );
    return rows
      .filter((row) => row.proposalId === proposalId)
      .sort((left, right) => {
        if (left.observedAt !== right.observedAt) return left.observedAt < right.observedAt ? -1 : 1;
        return (
          (ordinals.get(sampleKey(left.proposalId, left.evaluationRunId)) ?? 0) -
          (ordinals.get(sampleKey(right.proposalId, right.evaluationRunId)) ?? 0)
        );
      })
      .map((row) => structuredClone(row));
  }
}

/** Construct all three adapters over one in-memory database. */
export function createMemoryImprovementStores(db: MemoryDb): {
  readonly observations: MemoryObservationStore;
  readonly artifacts: MemoryArtifactStore;
  readonly proposals: MemoryProposalStore;
} {
  return {
    observations: new MemoryObservationStore(db),
    artifacts: new MemoryArtifactStore(db),
    proposals: new MemoryProposalStore(db),
  };
}

/**
 * Strictly after and strictly before, matching the operating record's filters.
 *
 * The two adapters and the two modules use the same comparison, so a boundary
 * row cannot appear in one and not the other — which would make the correction
 * rate in `watch.ts` differ between a test and production.
 */
function matchesObservationFilter(row: Observation, filter: ObservationFilter): boolean {
  if (filter.kind && !filter.kind.includes(row.kind)) return false;
  if (filter.runId !== undefined && row.runId !== filter.runId) return false;
  if (filter.roleId !== undefined && row.roleId !== filter.roleId) return false;
  if (filter.signature !== undefined && row.signature !== filter.signature) return false;
  if (filter.recordedAfter !== undefined && !(row.recordedAt > filter.recordedAfter)) return false;
  if (filter.recordedBefore !== undefined && !(row.recordedAt < filter.recordedBefore)) {
    return false;
  }
  return true;
}

function assertObservationRow(observation: Observation): void {
  assertIsoUtc("recordedAt", observation.recordedAt);
  if (!OBSERVATION_KINDS.includes(observation.kind)) {
    throw new InvalidInputError(`Unknown observation kind "${observation.kind}".`, "kind");
  }
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9][a-z0-9_]*)*$/.test(observation.signature)) {
    throw new InvalidInputError(
      `Signature "${observation.signature}" must be dotted lower_snake_case.`,
      "signature",
    );
  }
  if (observation.note.length < 1 || observation.note.length > 500) {
    throw new InvalidInputError(`An observation needs a note of 1 to 500 characters.`, "note");
  }
  if (observation.correctionMinutes < 0 || observation.correctionMinutes > 1440) {
    throw new InvalidInputError(
      `Correction minutes must be between 0 and 1440.`,
      "correctionMinutes",
    );
  }
  if (observation.costUsd < 0) {
    throw new InvalidInputError(`An observation cannot carry a negative cost.`, "costUsd");
  }
  if (observation.beforeDigest !== undefined && !isDigest(observation.beforeDigest)) {
    throw new InvalidInputError(`beforeDigest must be a sha256 digest.`, "beforeDigest");
  }
  if (observation.afterDigest !== undefined && !isDigest(observation.afterDigest)) {
    throw new InvalidInputError(`afterDigest must be a sha256 digest.`, "afterDigest");
  }
  if (observation.idempotencyKey.length === 0) {
    throw new InvalidInputError(
      `An observation needs an idempotency key, or a retry doubles a cluster's count.`,
      "idempotencyKey",
    );
  }
}

function assertArtifactRow(artifact: ArtifactRecord): void {
  assertIsoUtc("recordedAt", artifact.recordedAt);
  if (!ARTIFACT_KINDS.includes(artifact.kind)) {
    throw new InvalidInputError(`Unknown artifact kind "${artifact.kind}".`, "kind");
  }
  if (!Number.isInteger(artifact.version) || artifact.version < 1) {
    throw new InvalidInputError(`An artifact version must be a positive integer.`, "version");
  }
  if (!isDigest(artifact.digest)) {
    throw new InvalidInputError(`An artifact version needs a sha256 digest.`, "digest");
  }
  // Mirrors the provenance CHECK. Version 1 is the artifact as the deployment
  // declared it, reviewed in source control. Every version after it names the
  // proposal and the approval that produced it — which is what makes "nothing
  // changes behaviour without a recorded human decision" a property of the
  // store rather than only of the code path that usually writes to it.
  const hasProposal = artifact.proposalId !== undefined;
  const hasApproval = artifact.approvalId !== undefined;

  if (artifact.version === 1) {
    if (hasProposal || hasApproval) {
      throw new InvalidInputError(
        `The first version of artifact "${artifact.id}" comes from deployment configuration and carries no runtime approval. A first version proposed by the loop would be the loop creating an artifact, which it does not do.`,
        "approvalId",
      );
    }
    return;
  }

  if (!hasProposal || !hasApproval) {
    throw new InvalidInputError(
      `Version ${artifact.version} of artifact "${artifact.id}" names no proposal and approval. Every version after the first was applied on a human decision, and the record says which one.`,
      "approvalId",
    );
  }
  if (!String(artifact.approvalId).startsWith("apr_")) {
    throw new InvalidInputError(
      `An artifact version's approvalId must be an approval identifier.`,
      "approvalId",
    );
  }
}

function assertProposalRow(proposal: Proposal): void {
  assertIsoUtc("createdAt", proposal.createdAt);
  if (!PROPOSAL_STATUSES.includes(proposal.status)) {
    throw new InvalidInputError(`Unknown proposal status "${proposal.status}".`, "status");
  }
  if (!ARTIFACT_KINDS.includes(proposal.target.kind)) {
    throw new InvalidInputError(`Unknown artifact kind "${proposal.target.kind}".`, "target");
  }
  if (!isDigest(proposal.digest)) {
    throw new InvalidInputError(`A proposal needs a sha256 digest.`, "digest");
  }
  if (proposal.rationale.length < 1 || proposal.rationale.length > 1000) {
    throw new InvalidInputError(`A proposal needs a rationale of 1 to 1000 characters.`, "rationale");
  }
  if (!Number.isInteger(proposal.roleVersion) || proposal.roleVersion < 1) {
    throw new InvalidInputError(`A proposal needs a positive role version.`, "roleVersion");
  }
  // The two constraints that carry the product's claim, mirrored from the
  // schema: measured before it is offered, decided before it is applied.
  if (proposal.status !== "drafted" && !proposal.evaluation) {
    throw new InvalidInputError(
      `Proposal ${proposal.id} is ${proposal.status} without an evaluation. Every proposal is measured before anybody sees it.`,
      "evaluation",
    );
  }
  if (
    !["drafted", "withheld", "offered"].includes(proposal.status) &&
    !proposal.decision
  ) {
    throw new InvalidInputError(
      `Proposal ${proposal.id} is ${proposal.status} without a recorded human decision.`,
      "decision",
    );
  }
}

function assertApplicationRow(application: AppliedChange): void {
  assertIsoUtc("appliedAt", application.appliedAt);
  assertOptionalIsoUtc("revertedAt", application.revertedAt);
  if (
    typeof application.approvalId !== "string" ||
    !application.approvalId.startsWith("apr_")
  ) {
    // The whole product claim, as a row constraint: there is no applied change
    // without a recorded human decision.
    throw new InvalidInputError(
      `An applied change names the approval it was applied on. There is no row in this table without a human decision behind it.`,
      "approvalId",
    );
  }
  if (!isDigest(application.snapshot.digest) || !isDigest(application.installed.digest)) {
    throw new InvalidInputError(
      `An applied change needs digests of the state it replaced and the state it installed.`,
      "snapshot",
    );
  }
  if (application.revertedAt !== undefined && !application.revertedBy) {
    throw new InvalidInputError(
      `A reverted change names who reverted it. A rollback with nobody's name on it is the shape an autonomous rollback would take.`,
      "revertedBy",
    );
  }
}
