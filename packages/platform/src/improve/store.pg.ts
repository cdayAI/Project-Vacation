import { canonicalJson } from "../kernel/canonical.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc } from "../record/migrations.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";
import { storeUnavailable, type Db } from "../store/db.js";
import type {
  AppendObservationResult,
  ArtifactStore,
  ObservationStore,
  ProposalStore,
} from "./port.js";
import { assertTransition } from "./types.js";
import type {
  AppliedChange,
  ArtifactContent,
  ArtifactKind,
  ArtifactRecord,
  ArtifactState,
  Observation,
  ObservationFilter,
  ObservationKind,
  Proposal,
  ProposalDecision,
  ProposalEvaluation,
  ProposalFilter,
  ProposalPatch,
  ProposalStatus,
  QualitySample,
} from "./types.js";

/**
 * Postgres improvement-loop storage.
 *
 * Every operation whose correctness depends on what it read opens a
 * transaction and takes a row lock first. Two of them carry the module's
 * central guarantees and are worth naming:
 *
 *   `installArtifact` locks the head row, compares it against the version the
 *   approver saw, and writes only if they match. Without the lock, two
 *   applications would both read "v3 is live" and both write v4 — and the
 *   second would silently install a change over a state its approver never
 *   saw, which is the exact failure the snapshot exists to prevent.
 *
 *   `markReverted` is a single conditional UPDATE with `reverted_at IS NULL` in
 *   its WHERE clause, so a second revert affects no rows and returns null
 *   rather than rolling back whatever was applied after the first one.
 *
 * On the insert races the lock cannot cover — two callers creating the *first*
 * head row for an artifact, two recording the same application — the unique
 * constraint decides, and a 23505 is translated into the same `null` or refusal
 * the locked path produces. `SELECT ... FOR UPDATE` locks rows that exist; it
 * does nothing about a row that does not exist yet.
 *
 * `numeric` columns arrive from `pg` as strings so large values do not lose
 * precision in transit, and are converted explicitly on the way out. A numeric
 * reaching an accuracy comparison as a string would make `"0.9" >= 0.85`
 * compare lexicographically and pass for the wrong reason.
 */

type ObservationRow = {
  id: string;
  kind: string;
  run_id: string;
  step_id: string | null;
  role_id: string | null;
  role_version: number | null;
  workflow_kind: string | null;
  signature: string;
  note: string;
  observed_by: ActorRef;
  recorded_at: string;
  before_digest: string | null;
  after_digest: string | null;
  correction_minutes: string;
  cost_usd: string;
  subject: Record<string, string>;
  idempotency_key: string;
};

type ArtifactRow = {
  kind: string;
  id: string;
  version: number;
  content: ArtifactContent;
  digest: string;
  recorded_at: string;
  recorded_by: ActorRef;
  proposal_id: string | null;
  approval_id: string | null;
};

type ProposalRow = {
  id: string;
  status: string;
  target_kind: string;
  target_id: string;
  role_id: string;
  role_version: number;
  cluster_key: string;
  observation_ids: string[];
  rationale: string;
  before_state: ArtifactState;
  after_state: ArtifactState;
  added_cases: Proposal["addedCases"] | null;
  digest: string;
  created_at: string;
  created_by: ActorRef;
  evaluation: ProposalEvaluation | null;
  decision: ProposalDecision | null;
};

type ApplicationRow = {
  proposal_id: string;
  approval_id: string;
  target_kind: string;
  target_id: string;
  snapshot: ArtifactState;
  installed: ArtifactState;
  revertible: boolean;
  applied_at: string;
  applied_by: ActorRef;
  run_id: string;
  reverted_at: string | null;
  reverted_by: ActorRef | null;
  revert_reason: string | null;
};

type SampleRow = {
  proposal_id: string;
  evaluation_run_id: string;
  golden_set_digest: string;
  accuracy: string;
  case_count: number;
  regressed_case_ids: string[];
  observed_at: string;
};

const OBSERVATION_COLUMNS = `id, kind, run_id, step_id, role_id, role_version, workflow_kind,
  signature, note, observed_by, recorded_at, before_digest, after_digest, correction_minutes,
  cost_usd, subject, idempotency_key`;

const ARTIFACT_COLUMNS = `kind, id, version, content, digest, recorded_at, recorded_by,
  proposal_id, approval_id`;

const PROPOSAL_COLUMNS = `id, status, target_kind, target_id, role_id, role_version, cluster_key,
  observation_ids, rationale, before_state, after_state, added_cases, digest, created_at,
  created_by, evaluation, decision`;

const APPLICATION_COLUMNS = `proposal_id, approval_id, target_kind, target_id, snapshot,
  installed, revertible, applied_at, applied_by, run_id, reverted_at, reverted_by, revert_reason`;

const SAMPLE_COLUMNS = `proposal_id, evaluation_run_id, golden_set_digest, accuracy, case_count,
  regressed_case_ids, observed_at`;

export class PgObservationStore implements ObservationStore {
  constructor(private readonly db: Db) {}

  async appendObservation(observation: Observation): Promise<AppendObservationResult> {
    assertIsoUtc("recordedAt", observation.recordedAt);

    return this.guard("appendObservation", async () => {
      const inserted = await this.db.query<ObservationRow>(
        `INSERT INTO improvement_observation (${OBSERVATION_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${OBSERVATION_COLUMNS}`,
        [
          observation.id,
          observation.kind,
          observation.runId,
          observation.stepId ?? null,
          observation.roleId ?? null,
          observation.roleVersion ?? null,
          observation.workflowKind ?? null,
          observation.signature,
          observation.note,
          JSON.stringify(observation.observedBy),
          observation.recordedAt,
          observation.beforeDigest ?? null,
          observation.afterDigest ?? null,
          observation.correctionMinutes,
          observation.costUsd,
          JSON.stringify(observation.subject),
          observation.idempotencyKey,
        ],
      );

      const row = inserted[0];
      if (row) return { observation: toObservation(row), recorded: true };

      // Nothing inserted, so this correction is already recorded. Returning it
      // rather than raising is the point: a retried submission must not double
      // the frequency a cluster reports.
      const existing = await this.db.query<ObservationRow>(
        `SELECT ${OBSERVATION_COLUMNS} FROM improvement_observation WHERE idempotency_key = $1`,
        [observation.idempotencyKey],
      );
      const found = existing[0];
      if (!found) {
        throw new DeniedError(
          "record.unavailable",
          `Observation ${observation.id} was neither inserted nor found, so it is not known whether the correction was recorded.`,
          { observationId: observation.id },
        );
      }
      return { observation: toObservation(found), recorded: false };
    });
  }

  async getObservation(id: Id<"observation">): Promise<Observation | null> {
    const rows = await this.guard("getObservation", () =>
      this.db.query<ObservationRow>(
        `SELECT ${OBSERVATION_COLUMNS} FROM improvement_observation WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toObservation(row) : null;
  }

  async listObservations(filter: ObservationFilter = {}): Promise<readonly Observation[]> {
    const { clauses, values } = observationClauses(filter);

    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page += ` LIMIT $${values.length}`;
    }
    if (filter.offset !== undefined) {
      values.push(filter.offset);
      page += ` OFFSET $${values.length}`;
    }

    const rows = await this.guard("listObservations", () =>
      this.db.query<ObservationRow>(
        `SELECT ${OBSERVATION_COLUMNS} FROM improvement_observation
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY recorded_at ASC, ordinal ASC${page}`,
        values,
      ),
    );
    return rows.map(toObservation);
  }

  async countObservations(filter: ObservationFilter = {}): Promise<number> {
    const { clauses, values } = observationClauses(filter);
    const rows = await this.guard("countObservations", () =>
      this.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM improvement_observation
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}`,
        values,
      ),
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DeniedError || error instanceof InvalidInputError) throw error;
      throw storeUnavailable(operation, error);
    }
  }
}

export class PgArtifactStore implements ArtifactStore {
  constructor(private readonly db: Db) {}

  async head(kind: ArtifactKind, id: string): Promise<ArtifactRecord | null> {
    const rows = await this.guard("head", () =>
      this.db.query<ArtifactRow>(
        `SELECT a.kind, a.id, a.version, a.content, a.digest, a.recorded_at, a.recorded_by,
                a.proposal_id, a.approval_id
         FROM improvement_artifact_head h
         JOIN improvement_artifact a
           ON a.kind = h.kind AND a.id = h.id AND a.version = h.version
         WHERE h.kind = $1 AND h.id = $2`,
        [kind, id],
      ),
    );
    const row = rows[0];
    return row ? toArtifact(row) : null;
  }

  async getArtifactVersion(
    kind: ArtifactKind,
    id: string,
    version: number,
  ): Promise<ArtifactRecord | null> {
    const rows = await this.guard("getArtifactVersion", () =>
      this.db.query<ArtifactRow>(
        `SELECT ${ARTIFACT_COLUMNS} FROM improvement_artifact
         WHERE kind = $1 AND id = $2 AND version = $3`,
        [kind, id, version],
      ),
    );
    const row = rows[0];
    return row ? toArtifact(row) : null;
  }

  async listArtifactVersions(kind: ArtifactKind, id: string): Promise<readonly ArtifactRecord[]> {
    const rows = await this.guard("listArtifactVersions", () =>
      this.db.query<ArtifactRow>(
        `SELECT ${ARTIFACT_COLUMNS} FROM improvement_artifact
         WHERE kind = $1 AND id = $2 ORDER BY version ASC`,
        [kind, id],
      ),
    );
    return rows.map(toArtifact);
  }

  async listHeads(kind?: ArtifactKind): Promise<readonly ArtifactRecord[]> {
    const rows = await this.guard("listHeads", () =>
      this.db.query<ArtifactRow>(
        `SELECT a.kind, a.id, a.version, a.content, a.digest, a.recorded_at, a.recorded_by,
                a.proposal_id, a.approval_id
         FROM improvement_artifact_head h
         JOIN improvement_artifact a
           ON a.kind = h.kind AND a.id = h.id AND a.version = h.version
         ${kind === undefined ? "" : "WHERE h.kind = $1"}
         ORDER BY a.kind ASC, a.id ASC`,
        kind === undefined ? [] : [kind],
      ),
    );
    return rows.map(toArtifact);
  }

  async installArtifact(input: {
    readonly artifact: ArtifactRecord;
    readonly expectedHeadVersion: number | undefined;
  }): Promise<ArtifactRecord | null> {
    const artifact = input.artifact;
    assertIsoUtc("recordedAt", artifact.recordedAt);

    return this.guard("installArtifact", () =>
      this.db.transaction(async (tx) => {
        const heads = await tx.query<{ version: number }>(
          `SELECT version FROM improvement_artifact_head
           WHERE kind = $1 AND id = $2 FOR UPDATE`,
          [artifact.kind, artifact.id],
        );
        const current = heads[0]?.version;

        // Compare-and-set against the state the approver saw.
        if (current !== input.expectedHeadVersion) return null;

        const expected = (current ?? 0) + 1;
        if (artifact.version !== expected) {
          throw new InvalidInputError(
            `Artifact "${artifact.id}" is at v${current ?? 0}; the next version is ${expected}, not ${artifact.version}. History is append-only and contiguous.`,
            "version",
          );
        }

        await tx.query(
          `INSERT INTO improvement_artifact (${ARTIFACT_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            artifact.kind,
            artifact.id,
            artifact.version,
            JSON.stringify(artifact.content),
            artifact.digest,
            artifact.recordedAt,
            JSON.stringify(artifact.recordedBy),
            artifact.proposalId ?? null,
            artifact.approvalId ?? null,
          ],
        );

        if (current === undefined) {
          // First head row for this artifact. `FOR UPDATE` locks rows that
          // exist and does nothing about one that does not, so the unique
          // constraint is what decides a race here — and losing it means
          // somebody else registered it first, which is a lost compare-and-set
          // like any other.
          try {
            await tx.query(
              `INSERT INTO improvement_artifact_head (kind, id, version, updated_at, updated_by)
               VALUES ($1,$2,$3,$4,$5)`,
              [
                artifact.kind,
                artifact.id,
                artifact.version,
                artifact.recordedAt,
                JSON.stringify(artifact.recordedBy),
              ],
            );
          } catch (error) {
            if ((error as { code?: string } | null)?.code === "23505") return null;
            throw error;
          }
        } else {
          await tx.query(
            `UPDATE improvement_artifact_head
             SET version = $3, updated_at = $4, updated_by = $5
             WHERE kind = $1 AND id = $2`,
            [
              artifact.kind,
              artifact.id,
              artifact.version,
              artifact.recordedAt,
              JSON.stringify(artifact.recordedBy),
            ],
          );
        }

        return structuredClone(artifact);
      }),
    );
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

    return this.guard("restoreArtifact", () =>
      this.db.transaction(async (tx) => {
        const heads = await tx.query<{ version: number }>(
          `SELECT version FROM improvement_artifact_head
           WHERE kind = $1 AND id = $2 FOR UPDATE`,
          [input.kind, input.id],
        );
        const current = heads[0]?.version;
        if (current === undefined || current !== input.expectedHeadVersion) return null;

        const targets = await tx.query<ArtifactRow>(
          `SELECT ${ARTIFACT_COLUMNS} FROM improvement_artifact
           WHERE kind = $1 AND id = $2 AND version = $3`,
          [input.kind, input.id, input.toVersion],
        );
        const target = targets[0];
        if (!target) return null;

        // The rolled-off version stays in the history; only the pointer moves.
        await tx.query(
          `UPDATE improvement_artifact_head
           SET version = $3, updated_at = $4, updated_by = $5
           WHERE kind = $1 AND id = $2`,
          [input.kind, input.id, input.toVersion, input.at, JSON.stringify(input.by)],
        );

        return toArtifact(target);
      }),
    );
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DeniedError || error instanceof InvalidInputError) throw error;
      throw storeUnavailable(operation, error);
    }
  }
}

export class PgProposalStore implements ProposalStore {
  constructor(private readonly db: Db) {}

  async createProposal(proposal: Proposal): Promise<Proposal> {
    assertIsoUtc("createdAt", proposal.createdAt);

    return this.guard("createProposal", async () => {
      await this.db.query(
        `INSERT INTO improvement_proposal (${PROPOSAL_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          proposal.id,
          proposal.status,
          proposal.target.kind,
          proposal.target.id,
          proposal.roleId,
          proposal.roleVersion,
          proposal.clusterKey,
          JSON.stringify(proposal.observationIds),
          proposal.rationale,
          JSON.stringify(proposal.before),
          JSON.stringify(proposal.after),
          proposal.addedCases ? JSON.stringify(proposal.addedCases) : null,
          proposal.digest,
          proposal.createdAt,
          JSON.stringify(proposal.createdBy),
          proposal.evaluation ? JSON.stringify(proposal.evaluation) : null,
          proposal.decision ? JSON.stringify(proposal.decision) : null,
        ],
      );
      return structuredClone(proposal);
    });
  }

  async getProposal(id: Id<"proposal">): Promise<Proposal | null> {
    const rows = await this.guard("getProposal", () =>
      this.db.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM improvement_proposal WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toProposal(row) : null;
  }

  async requireProposal(id: Id<"proposal">): Promise<Proposal> {
    const found = await this.getProposal(id);
    if (!found) {
      throw new DeniedError("record.unavailable", `Proposal ${id} is not in the record.`, {
        proposalId: id,
      });
    }
    return found;
  }

  async listProposals(filter: ProposalFilter = {}): Promise<readonly Proposal[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (filter.status && filter.status.length > 0) {
      values.push(filter.status);
      clauses.push(`status = ANY($${values.length})`);
    }
    if (filter.roleId !== undefined) {
      values.push(filter.roleId);
      clauses.push(`role_id = $${values.length}`);
    }
    if (filter.targetKind !== undefined) {
      values.push(filter.targetKind);
      clauses.push(`target_kind = $${values.length}`);
    }
    if (filter.targetId !== undefined) {
      values.push(filter.targetId);
      clauses.push(`target_id = $${values.length}`);
    }

    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page += ` LIMIT $${values.length}`;
    }
    if (filter.offset !== undefined) {
      values.push(filter.offset);
      page += ` OFFSET $${values.length}`;
    }

    const rows = await this.guard("listProposals", () =>
      this.db.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM improvement_proposal
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY created_at DESC, ordinal DESC${page}`,
        values,
      ),
    );
    return rows.map(toProposal);
  }

  async transitionProposal(input: {
    readonly id: Id<"proposal">;
    readonly expectedStatus: ProposalStatus;
    readonly nextStatus: ProposalStatus;
    readonly patch?: ProposalPatch | undefined;
  }): Promise<Proposal | null> {
    assertTransition(input.expectedStatus, input.nextStatus);

    return this.guard("transitionProposal", () =>
      this.db.transaction(async (tx) => {
        const rows = await tx.query<ProposalRow>(
          `SELECT ${PROPOSAL_COLUMNS} FROM improvement_proposal WHERE id = $1 FOR UPDATE`,
          [input.id],
        );
        const current = rows[0];
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

        const evaluation = input.patch?.evaluation ?? current.evaluation;
        const decision = input.patch?.decision ?? current.decision;

        const updated = await tx.query<ProposalRow>(
          `UPDATE improvement_proposal
           SET status = $2, evaluation = $3, decision = $4
           WHERE id = $1
           RETURNING ${PROPOSAL_COLUMNS}`,
          [
            input.id,
            input.nextStatus,
            evaluation ? JSON.stringify(evaluation) : null,
            decision ? JSON.stringify(decision) : null,
          ],
        );
        const row = updated[0];
        return row ? toProposal(row) : null;
      }),
    );
  }

  async recordApplication(application: AppliedChange): Promise<AppliedChange> {
    assertIsoUtc("appliedAt", application.appliedAt);

    return this.guard("recordApplication", async () => {
      const inserted = await this.db.query<ApplicationRow>(
        `INSERT INTO improvement_application (${APPLICATION_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (proposal_id) DO NOTHING
         RETURNING ${APPLICATION_COLUMNS}`,
        [
          application.proposalId,
          application.approvalId,
          application.target.kind,
          application.target.id,
          JSON.stringify(application.snapshot),
          JSON.stringify(application.installed),
          application.revertible,
          application.appliedAt,
          JSON.stringify(application.appliedBy),
          application.runId,
          application.revertedAt ?? null,
          application.revertedBy ? JSON.stringify(application.revertedBy) : null,
          application.revertReason ?? null,
        ],
      );

      const row = inserted[0];
      if (row) return toApplication(row);

      const existing = await this.getApplication(application.proposalId);
      if (existing && canonicalJson(existing) === canonicalJson(application)) return existing;
      throw new DeniedError(
        "record.unavailable",
        `Proposal ${application.proposalId} has already been applied. A change is applied once; to change the artifact again, propose the next change against the state that is live now.`,
        { proposalId: application.proposalId },
      );
    });
  }

  async getApplication(proposalId: Id<"proposal">): Promise<AppliedChange | null> {
    const rows = await this.guard("getApplication", () =>
      this.db.query<ApplicationRow>(
        `SELECT ${APPLICATION_COLUMNS} FROM improvement_application WHERE proposal_id = $1`,
        [proposalId],
      ),
    );
    const row = rows[0];
    return row ? toApplication(row) : null;
  }

  async listApplications(
    filter: { readonly reverted?: boolean | undefined; readonly limit?: number | undefined } = {},
  ): Promise<readonly AppliedChange[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (filter.reverted !== undefined) {
      clauses.push(filter.reverted ? "reverted_at IS NOT NULL" : "reverted_at IS NULL");
    }

    let page = "";
    if (filter.limit !== undefined) {
      values.push(filter.limit);
      page += ` LIMIT $${values.length}`;
    }

    const rows = await this.guard("listApplications", () =>
      this.db.query<ApplicationRow>(
        `SELECT ${APPLICATION_COLUMNS} FROM improvement_application
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY applied_at DESC, ordinal DESC${page}`,
        values,
      ),
    );
    return rows.map(toApplication);
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

    // One conditional UPDATE rather than a read and a write: `reverted_at IS
    // NULL` in the WHERE clause is the compare-and-set, so a second revert
    // affects no rows instead of rolling back whatever was applied after the
    // first one.
    const rows = await this.guard("markReverted", () =>
      this.db.query<ApplicationRow>(
        `UPDATE improvement_application
         SET reverted_at = $2, reverted_by = $3, revert_reason = $4
         WHERE proposal_id = $1 AND reverted_at IS NULL AND revertible
         RETURNING ${APPLICATION_COLUMNS}`,
        [input.proposalId, input.revertedAt, JSON.stringify(input.revertedBy), input.reason],
      ),
    );
    const row = rows[0];
    return row ? toApplication(row) : null;
  }

  async recordQualitySample(sample: QualitySample): Promise<QualitySample> {
    assertIsoUtc("observedAt", sample.observedAt);

    return this.guard("recordQualitySample", async () => {
      const inserted = await this.db.query<SampleRow>(
        `INSERT INTO improvement_quality_sample (${SAMPLE_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (proposal_id, evaluation_run_id) DO NOTHING
         RETURNING ${SAMPLE_COLUMNS}`,
        [
          sample.proposalId,
          sample.evaluationRunId,
          sample.goldenSetDigest,
          sample.accuracy,
          sample.caseCount,
          JSON.stringify(sample.regressedCaseIds),
          sample.observedAt,
        ],
      );

      const row = inserted[0];
      if (row) return toSample(row);

      const existing = (await this.listQualitySamples(sample.proposalId)).find(
        (entry) => entry.evaluationRunId === sample.evaluationRunId,
      );
      if (existing && canonicalJson(existing) === canonicalJson(sample)) return existing;
      throw new DeniedError(
        "record.unavailable",
        `Evaluation run ${sample.evaluationRunId} is already recorded against proposal ${sample.proposalId} with different numbers. A measurement whose figures can be rewritten afterwards is not evidence.`,
        { proposalId: sample.proposalId, evaluationRunId: sample.evaluationRunId },
      );
    });
  }

  async listQualitySamples(proposalId: Id<"proposal">): Promise<readonly QualitySample[]> {
    const rows = await this.guard("listQualitySamples", () =>
      this.db.query<SampleRow>(
        `SELECT ${SAMPLE_COLUMNS} FROM improvement_quality_sample
         WHERE proposal_id = $1 ORDER BY observed_at ASC, evaluation_run_id ASC`,
        [proposalId],
      ),
    );
    return rows.map(toSample);
  }

  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DeniedError || error instanceof InvalidInputError) throw error;
      throw storeUnavailable(operation, error);
    }
  }
}

function observationClauses(filter: ObservationFilter): {
  readonly clauses: string[];
  readonly values: unknown[];
} {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (filter.kind && filter.kind.length > 0) {
    values.push(filter.kind);
    clauses.push(`kind = ANY($${values.length})`);
  }
  if (filter.runId !== undefined) {
    values.push(filter.runId);
    clauses.push(`run_id = $${values.length}`);
  }
  if (filter.roleId !== undefined) {
    values.push(filter.roleId);
    clauses.push(`role_id = $${values.length}`);
  }
  if (filter.signature !== undefined) {
    values.push(filter.signature);
    clauses.push(`signature = $${values.length}`);
  }
  // Strictly after and strictly before, matching the operating record's
  // filters and the in-memory adapter, so a boundary row cannot appear in one
  // and not the other.
  if (filter.recordedAfter !== undefined) {
    values.push(filter.recordedAfter);
    clauses.push(`recorded_at > $${values.length}`);
  }
  if (filter.recordedBefore !== undefined) {
    values.push(filter.recordedBefore);
    clauses.push(`recorded_at < $${values.length}`);
  }

  return { clauses, values };
}

function toObservation(row: ObservationRow): Observation {
  return {
    id: row.id as Id<"observation">,
    kind: row.kind as ObservationKind,
    runId: row.run_id as Id<"run">,
    stepId: (row.step_id ?? undefined) as Id<"step"> | undefined,
    roleId: (row.role_id ?? undefined) as Id<"role"> | undefined,
    roleVersion: row.role_version === null ? undefined : Number(row.role_version),
    workflowKind: row.workflow_kind ?? undefined,
    signature: row.signature,
    note: row.note,
    observedBy: row.observed_by,
    recordedAt: row.recorded_at,
    beforeDigest: (row.before_digest ?? undefined) as Digest | undefined,
    afterDigest: (row.after_digest ?? undefined) as Digest | undefined,
    correctionMinutes: Number(row.correction_minutes),
    costUsd: Number(row.cost_usd),
    subject: row.subject,
    idempotencyKey: row.idempotency_key,
  };
}

function toArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    kind: row.kind as ArtifactKind,
    id: row.id,
    version: Number(row.version),
    content: row.content,
    digest: row.digest as Digest,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
    proposalId: (row.proposal_id ?? undefined) as Id<"proposal"> | undefined,
    approvalId: (row.approval_id ?? undefined) as Id<"approval"> | undefined,
  };
}

function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id as Id<"proposal">,
    status: row.status as ProposalStatus,
    target: { kind: row.target_kind as ArtifactKind, id: row.target_id },
    roleId: row.role_id as Id<"role">,
    roleVersion: Number(row.role_version),
    clusterKey: row.cluster_key,
    observationIds: row.observation_ids as readonly Id<"observation">[],
    rationale: row.rationale,
    before: row.before_state,
    after: row.after_state,
    addedCases: row.added_cases ?? undefined,
    digest: row.digest as Digest,
    createdAt: row.created_at,
    createdBy: row.created_by,
    evaluation: row.evaluation ?? undefined,
    decision: row.decision ?? undefined,
  };
}

function toApplication(row: ApplicationRow): AppliedChange {
  return {
    proposalId: row.proposal_id as Id<"proposal">,
    approvalId: row.approval_id as Id<"approval">,
    target: { kind: row.target_kind as ArtifactKind, id: row.target_id },
    snapshot: row.snapshot,
    installed: row.installed,
    revertible: row.revertible,
    appliedAt: row.applied_at,
    appliedBy: row.applied_by,
    runId: row.run_id as Id<"run">,
    revertedAt: row.reverted_at ?? undefined,
    revertedBy: row.reverted_by ?? undefined,
    revertReason: row.revert_reason ?? undefined,
  };
}

function toSample(row: SampleRow): QualitySample {
  return {
    proposalId: row.proposal_id as Id<"proposal">,
    evaluationRunId: row.evaluation_run_id as Id<"evaluation">,
    goldenSetDigest: row.golden_set_digest as Digest,
    // numeric arrives as a string; comparing it as one against a baseline
    // accuracy would compare lexicographically and pass for the wrong reason.
    accuracy: Number(row.accuracy),
    caseCount: Number(row.case_count),
    regressedCaseIds: row.regressed_case_ids,
    observedAt: row.observed_at,
  };
}
