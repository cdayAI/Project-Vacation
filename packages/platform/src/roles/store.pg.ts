import { canonicalJson } from "../kernel/canonical.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import type { Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc } from "../record/migrations.js";
import type { ActorRef, IsoTimestamp } from "../record/types.js";
import { storeUnavailable, type Db } from "../store/db.js";
import { goldenSetDigest } from "./evaluation.js";
import type { EvaluationStore, PromoteResult, RoleStore } from "./port.js";
import {
  PROMOTABLE_STATUSES,
  type CaseResult,
  type EvaluationFilter,
  type EvaluationRun,
  type GoldenCase,
  type GoldenSet,
  type PromotionEvidence,
  type Role,
  type RoleDefinition,
  type RoleStatus,
  type RoleVersion,
} from "./types.js";

/**
 * Postgres role governance.
 *
 * Every mutating operation opens a transaction and takes a row lock on
 * `agent_role` before it reads anything it is about to decide on. That is what
 * makes version numbering, promotion, and the lifecycle transitions atomic
 * under concurrency rather than merely usually correct: two authors appending
 * versions serialise behind the lock, and two promotions cannot both observe
 * "nothing is promoted".
 *
 * The compare-and-set operations return `null` on a lost race rather than
 * throwing, matching the approval store. The caller turns that into a refusal
 * with a message about what actually happened, which is more useful than a
 * constraint violation surfacing from three layers down.
 *
 * `numeric` columns arrive from `pg` as strings so large values do not lose
 * precision in transit. They are converted explicitly on the way out; letting a
 * numeric reach an accuracy comparison as a string would make `"0.9" >= 0.85`
 * compare lexicographically and pass for the wrong reason.
 */

type RoleRow = {
  id: string;
  name: string;
  created_at: string;
  created_by: ActorRef;
  latest_version: number;
  promoted_version: number | null;
  identity_digest: string;
};

type VersionRow = {
  role_id: string;
  version: number;
  id: string;
  status: string;
  definition: RoleDefinition;
  definition_digest: string;
  created_at: string;
  created_by: ActorRef;
  change_note: string;
  evidence: PromotionEvidence | null;
  restored_from: number | null;
  rolled_off_at: string | null;
};

type GoldenSetRow = {
  id: string;
  version: number;
  task: string;
  synthetic: boolean;
  threshold: string;
  curated_by: string;
  curated_at: string;
  cases: GoldenCase[];
  case_count: number;
  digest: string;
};

type EvaluationRow = {
  id: string;
  role_id: string;
  role_version: number;
  definition_digest: string;
  golden_set_id: string;
  golden_set_version: number;
  golden_set_digest: string;
  task: string;
  model_id: string;
  model_version: string;
  prompt_template_id: string;
  prompt_template_version: number;
  run_id: string;
  evaluated_by: ActorRef;
  started_at: string;
  completed_at: string;
  case_count: number;
  passed: number;
  failed: number;
  errored: number;
  accuracy: string;
  threshold: string;
  meets_threshold: boolean;
  synthetic_fixtures: boolean;
  results: CaseResult[];
  total_cost_usd: string;
};

const ROLE_COLUMNS = `id, name, created_at, created_by, latest_version, promoted_version, identity_digest`;
const VERSION_COLUMNS = `role_id, version, id, status, definition, definition_digest,
  created_at, created_by, change_note, evidence, restored_from, rolled_off_at`;
const GOLDEN_COLUMNS = `id, version, task, synthetic, threshold, curated_by, curated_at,
  cases, case_count, digest`;
const EVALUATION_COLUMNS = `id, role_id, role_version, definition_digest, golden_set_id,
  golden_set_version, golden_set_digest, task, model_id, model_version, prompt_template_id,
  prompt_template_version, run_id, evaluated_by, started_at, completed_at, case_count,
  passed, failed, errored, accuracy, threshold, meets_threshold, synthetic_fixtures,
  results, total_cost_usd`;

export class PgRoleStore implements RoleStore {
  constructor(private readonly db: Db) {}

  async createRole(role: Role, firstVersion: RoleVersion): Promise<PromoteResult> {
    assertIsoUtc("createdAt", role.createdAt);
    assertIsoUtc("createdAt", firstVersion.createdAt);
    if (firstVersion.roleId !== role.id || firstVersion.version !== 1) {
      throw new InvalidInputError(
        `A role's first version is version 1 of that role, not v${firstVersion.version} of ${firstVersion.roleId}.`,
        "version",
      );
    }

    return this.guard("createRole", () =>
      this.db.transaction(async (tx) => {
        try {
          await tx.query(
            `INSERT INTO agent_role (${ROLE_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              role.id,
              role.name,
              role.createdAt,
              JSON.stringify(role.createdBy),
              role.latestVersion,
              role.promotedVersion ?? null,
              role.identityDigest,
            ],
          );
        } catch (error) {
          throw translateRoleConflict(error, role.name);
        }

        await tx.query(
          `INSERT INTO agent_role_version (${VERSION_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          versionValues(firstVersion),
        );

        return { role: structuredClone(role), version: structuredClone(firstVersion) };
      }),
    );
  }

  async getRole(id: Id<"role">): Promise<Role | null> {
    const rows = await this.guard("getRole", () =>
      this.db.query<RoleRow>(`SELECT ${ROLE_COLUMNS} FROM agent_role WHERE id = $1`, [id]),
    );
    const row = rows[0];
    return row ? toRole(row) : null;
  }

  async requireRole(id: Id<"role">): Promise<Role> {
    const found = await this.getRole(id);
    if (!found) {
      // Refused rather than returned empty. A caller asking whether a role may
      // act, and getting "no role", must not read that as "no restrictions".
      throw new DeniedError("record.unavailable", `Role ${id} is not in the role registry.`, {
        roleId: id,
      });
    }
    return found;
  }

  async findRoleByName(name: string): Promise<Role | null> {
    const rows = await this.guard("findRoleByName", () =>
      this.db.query<RoleRow>(`SELECT ${ROLE_COLUMNS} FROM agent_role WHERE name = $1`, [name]),
    );
    const row = rows[0];
    return row ? toRole(row) : null;
  }

  async listRoles(): Promise<readonly Role[]> {
    const rows = await this.guard("listRoles", () =>
      this.db.query<RoleRow>(`SELECT ${ROLE_COLUMNS} FROM agent_role ORDER BY name ASC`),
    );
    return rows.map(toRole);
  }

  async appendVersion(
    version: Omit<RoleVersion, "version">,
    identityDigest: string,
  ): Promise<{ role: Role; version: RoleVersion }> {
    assertIsoUtc("createdAt", version.createdAt);

    return this.guard("appendVersion", () =>
      this.db.transaction(async (tx) => {
        const role = await lockRole(tx, version.roleId);

        // The number is assigned under the lock, so two authors editing the
        // same role concurrently produce v4 and v5 rather than two v4s.
        const next = role.latest_version + 1;
        const stored: RoleVersion = { ...version, version: next };

        await tx.query(
          `INSERT INTO agent_role_version (${VERSION_COLUMNS})
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          versionValues(stored),
        );

        try {
          await tx.query(
            `UPDATE agent_role SET latest_version = $2, identity_digest = $3 WHERE id = $1`,
            [role.id, next, identityDigest],
          );
        } catch (error) {
          throw translateRoleConflict(error, role.name);
        }

        return {
          role: toRole({ ...role, latest_version: next, identity_digest: identityDigest }),
          version: stored,
        };
      }),
    );
  }

  async getVersion(roleId: Id<"role">, version: number): Promise<RoleVersion | null> {
    const rows = await this.guard("getVersion", () =>
      this.db.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM agent_role_version WHERE role_id = $1 AND version = $2`,
        [roleId, version],
      ),
    );
    const row = rows[0];
    return row ? toVersion(row) : null;
  }

  async requireVersion(roleId: Id<"role">, version: number): Promise<RoleVersion> {
    const found = await this.getVersion(roleId, version);
    if (!found) {
      throw new DeniedError("record.unavailable", `Role ${roleId} has no version ${version}.`, {
        roleId,
        version,
      });
    }
    return found;
  }

  async listVersions(roleId: Id<"role">): Promise<readonly RoleVersion[]> {
    const rows = await this.guard("listVersions", () =>
      this.db.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM agent_role_version WHERE role_id = $1 ORDER BY version ASC`,
        [roleId],
      ),
    );
    return rows.map(toVersion);
  }

  async promotedVersion(roleId: Id<"role">): Promise<RoleVersion | null> {
    // Read from the status rather than the role's pointer. The unique partial
    // index guarantees at most one row matches, so this is the fact and the
    // pointer is the convenience.
    const rows = await this.guard("promotedVersion", () =>
      this.db.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM agent_role_version
         WHERE role_id = $1 AND status = 'promoted'`,
        [roleId],
      ),
    );
    const row = rows[0];
    return row ? toVersion(row) : null;
  }

  async promoteVersion(input: {
    readonly roleId: Id<"role">;
    readonly version: number;
    readonly evidence: PromotionEvidence;
    readonly at: IsoTimestamp;
    readonly expectedPromotedVersion: number | undefined;
  }): Promise<PromoteResult | null> {
    assertIsoUtc("at", input.at);
    if (!input.evidence) {
      throw new InvalidInputError(
        "A version cannot be promoted without the evaluation run and approval that justified it.",
        "evidence",
      );
    }

    return this.guard("promoteVersion", () =>
      this.db.transaction(async (tx) => {
        const role = await lockRole(tx, input.roleId);

        const targetRows = await tx.query<VersionRow>(
          `SELECT ${VERSION_COLUMNS} FROM agent_role_version
           WHERE role_id = $1 AND version = $2 FOR UPDATE`,
          [input.roleId, input.version],
        );
        const target = targetRows[0];
        if (!target) {
          throw new DeniedError(
            "record.unavailable",
            `Role ${input.roleId} has no version ${input.version}.`,
            { roleId: input.roleId, version: input.version },
          );
        }
        if (!PROMOTABLE_STATUSES.includes(target.status as RoleStatus)) {
          throw new InvalidInputError(
            `Version ${input.version} of role "${role.name}" is ${target.status} and cannot be promoted.`,
            "version",
          );
        }

        const currentRows = await tx.query<VersionRow>(
          `SELECT ${VERSION_COLUMNS} FROM agent_role_version
           WHERE role_id = $1 AND status = 'promoted' FOR UPDATE`,
          [input.roleId],
        );
        const current = currentRows[0];

        // Compare-and-set. A promotion approved against one starting state must
        // not land on a different one: the loser's approver never saw what is
        // there now.
        if (current?.version !== input.expectedPromotedVersion) return null;

        if (current) {
          await tx.query(
            `UPDATE agent_role_version SET status = 'reverted', rolled_off_at = $3
             WHERE role_id = $1 AND version = $2`,
            [input.roleId, current.version, input.at],
          );
        }

        await tx.query(
          `UPDATE agent_role_version
           SET status = 'promoted', evidence = $3, rolled_off_at = NULL
           WHERE role_id = $1 AND version = $2`,
          [input.roleId, input.version, JSON.stringify(input.evidence)],
        );
        await tx.query(`UPDATE agent_role SET promoted_version = $2 WHERE id = $1`, [
          input.roleId,
          input.version,
        ]);

        return {
          role: toRole({ ...role, promoted_version: input.version }),
          version: toVersion({
            ...target,
            status: "promoted",
            evidence: input.evidence,
            rolled_off_at: null,
          }),
          rolledOff: current
            ? toVersion({ ...current, status: "reverted", rolled_off_at: input.at })
            : undefined,
        };
      }),
    );
  }

  async setVersionStatus(input: {
    readonly roleId: Id<"role">;
    readonly version: number;
    readonly expectedStatus: RoleStatus;
    readonly nextStatus: RoleStatus;
    readonly at: IsoTimestamp;
  }): Promise<{ role: Role; version: RoleVersion } | null> {
    assertIsoUtc("at", input.at);

    return this.guard("setVersionStatus", () =>
      this.db.transaction(async (tx) => {
        const role = await lockRole(tx, input.roleId);

        const rows = await tx.query<VersionRow>(
          `SELECT ${VERSION_COLUMNS} FROM agent_role_version
           WHERE role_id = $1 AND version = $2 FOR UPDATE`,
          [input.roleId, input.version],
        );
        const target = rows[0];
        if (!target) {
          throw new DeniedError(
            "record.unavailable",
            `Role ${input.roleId} has no version ${input.version}.`,
            { roleId: input.roleId, version: input.version },
          );
        }

        // Compare-and-set on the status, so a disable that raced a promotion
        // refuses rather than acting on state it never read.
        if (target.status !== input.expectedStatus) return null;

        if (input.nextStatus === "promoted") {
          const others = await tx.query<{ version: number }>(
            `SELECT version FROM agent_role_version
             WHERE role_id = $1 AND status = 'promoted' AND version <> $2 FOR UPDATE`,
            [input.roleId, input.version],
          );
          // The unique partial index would refuse this anyway; checking first
          // turns a constraint violation into a clean lost-race answer.
          if (others.length > 0) return null;
        }

        const rolledOffAt =
          input.nextStatus === "promoted"
            ? null
            : target.status === "promoted"
              ? input.at
              : target.rolled_off_at;

        await tx.query(
          `UPDATE agent_role_version SET status = $3, rolled_off_at = $4
           WHERE role_id = $1 AND version = $2`,
          [input.roleId, input.version, input.nextStatus, rolledOffAt],
        );

        const promotedNow = input.nextStatus === "promoted";
        const wasPointer = role.promoted_version === input.version;
        const pointer = promotedNow ? input.version : wasPointer ? null : role.promoted_version;
        await tx.query(`UPDATE agent_role SET promoted_version = $2 WHERE id = $1`, [
          input.roleId,
          pointer,
        ]);

        return {
          role: toRole({ ...role, promoted_version: pointer }),
          version: toVersion({ ...target, status: input.nextStatus, rolled_off_at: rolledOffAt }),
        };
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

export class PgEvaluationStore implements EvaluationStore {
  constructor(private readonly db: Db) {}

  async putGoldenSet(set: GoldenSet): Promise<GoldenSet> {
    assertIsoUtc("curatedAt", set.curatedAt);
    const digest = goldenSetDigest(set);

    return this.guard("putGoldenSet", async () => {
      const inserted = await this.db.query<{ id: string }>(
        `INSERT INTO role_golden_set (${GOLDEN_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id, version) DO NOTHING
         RETURNING id`,
        [
          set.id,
          set.version,
          set.task,
          set.synthetic,
          set.threshold,
          set.curatedBy,
          set.curatedAt,
          JSON.stringify(set.cases),
          set.cases.length,
          digest,
        ],
      );
      if (inserted.length > 0) return structuredClone(set);

      // Nothing was inserted, so this version already exists. A repeat of the
      // same write is the crash-and-recover path and is allowed through; a
      // repeat with different content is an in-place edit of ground truth that
      // an evaluation run has already cited.
      const existing = await this.requireGoldenSet(set.id, set.version);
      if (canonicalJson(existing) === canonicalJson(set)) return existing;
      throw new DeniedError(
        "record.unavailable",
        `Golden set "${set.id}" v${set.version} already exists with different content. A curated set is immutable once published; publish a new version instead.`,
        { goldenSetId: set.id, version: set.version },
      );
    });
  }

  async getGoldenSet(id: string, version?: number): Promise<GoldenSet | null> {
    const rows = await this.guard("getGoldenSet", () =>
      version === undefined
        ? this.db.query<GoldenSetRow>(
            `SELECT ${GOLDEN_COLUMNS} FROM role_golden_set
             WHERE id = $1 ORDER BY version DESC LIMIT 1`,
            [id],
          )
        : this.db.query<GoldenSetRow>(
            `SELECT ${GOLDEN_COLUMNS} FROM role_golden_set WHERE id = $1 AND version = $2`,
            [id, version],
          ),
    );
    const row = rows[0];
    return row ? toGoldenSet(row) : null;
  }

  async requireGoldenSet(id: string, version?: number): Promise<GoldenSet> {
    const found = await this.getGoldenSet(id, version);
    if (!found) {
      throw new DeniedError(
        "record.unavailable",
        `Golden set "${id}"${version === undefined ? "" : ` v${version}`} is not in the record, so there is nothing to measure against.`,
        { goldenSetId: id },
      );
    }
    return found;
  }

  async listGoldenSets(): Promise<readonly GoldenSet[]> {
    const rows = await this.guard("listGoldenSets", () =>
      this.db.query<GoldenSetRow>(
        `SELECT ${GOLDEN_COLUMNS} FROM role_golden_set ORDER BY id ASC, version ASC`,
      ),
    );
    return rows.map(toGoldenSet);
  }

  async recordEvaluation(run: EvaluationRun): Promise<EvaluationRun> {
    assertIsoUtc("startedAt", run.startedAt);
    assertIsoUtc("completedAt", run.completedAt);
    if (run.passed + run.failed + run.errored !== run.caseCount) {
      throw new InvalidInputError(
        `Evaluation run ${run.id} reports ${run.passed}+${run.failed}+${run.errored} outcomes across ${run.caseCount} cases. The parts have to add up to the whole.`,
        "caseCount",
      );
    }

    return this.guard("recordEvaluation", async () => {
      const inserted = await this.db.query<{ id: string }>(
        `INSERT INTO role_evaluation_run (${EVALUATION_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          run.id,
          run.roleId,
          run.roleVersion,
          run.definitionDigest,
          run.goldenSetId,
          run.goldenSetVersion,
          run.goldenSetDigest,
          run.task,
          run.modelId,
          run.modelVersion,
          run.promptTemplateId,
          run.promptTemplateVersion,
          run.runId,
          JSON.stringify(run.evaluatedBy),
          run.startedAt,
          run.completedAt,
          run.caseCount,
          run.passed,
          run.failed,
          run.errored,
          run.accuracy,
          run.threshold,
          run.meetsThreshold,
          run.syntheticFixtures,
          JSON.stringify(run.results),
          run.totalCostUsd,
        ],
      );
      if (inserted.length > 0) return structuredClone(run);

      const existing = await this.getEvaluation(run.id);
      if (existing && canonicalJson(existing) === canonicalJson(run)) return existing;
      throw new DeniedError(
        "record.unavailable",
        `Evaluation run ${run.id} already exists with different results. Evidence whose numbers can be rewritten afterwards is not evidence.`,
        { evaluationRunId: run.id },
      );
    });
  }

  async getEvaluation(id: Id<"evaluation">): Promise<EvaluationRun | null> {
    const rows = await this.guard("getEvaluation", () =>
      this.db.query<EvaluationRow>(
        `SELECT ${EVALUATION_COLUMNS} FROM role_evaluation_run WHERE id = $1`,
        [id],
      ),
    );
    const row = rows[0];
    return row ? toEvaluation(row) : null;
  }

  async listEvaluations(filter: EvaluationFilter = {}): Promise<readonly EvaluationRun[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (filter.roleId !== undefined) {
      values.push(filter.roleId);
      clauses.push(`role_id = $${values.length}`);
    }
    if (filter.roleVersion !== undefined) {
      values.push(filter.roleVersion);
      clauses.push(`role_version = $${values.length}`);
    }
    if (filter.goldenSetId !== undefined) {
      values.push(filter.goldenSetId);
      clauses.push(`golden_set_id = $${values.length}`);
    }
    if (filter.meetsThreshold !== undefined) {
      values.push(filter.meetsThreshold);
      clauses.push(`meets_threshold = $${values.length}`);
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

    const rows = await this.guard("listEvaluations", () =>
      this.db.query<EvaluationRow>(
        `SELECT ${EVALUATION_COLUMNS} FROM role_evaluation_run
         ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY completed_at DESC, ordinal DESC${page}`,
        values,
      ),
    );
    return rows.map(toEvaluation);
  }

  async latestEvaluation(roleId: Id<"role">, roleVersion?: number): Promise<EvaluationRun | null> {
    const found = await this.listEvaluations({ roleId, roleVersion, limit: 1 });
    return found[0] ?? null;
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

/**
 * Take the role's row lock before reading anything the caller will decide on.
 *
 * Every mutating path goes through here. Without it, "read the promoted
 * version, then write" is a race, and the thing being raced is what a role is
 * allowed to do.
 */
async function lockRole(tx: Db, roleId: string): Promise<RoleRow> {
  const rows = await tx.query<RoleRow>(
    `SELECT ${ROLE_COLUMNS} FROM agent_role WHERE id = $1 FOR UPDATE`,
    [roleId],
  );
  const row = rows[0];
  if (!row) {
    throw new DeniedError("record.unavailable", `Role ${roleId} is not in the role registry.`, {
      roleId,
    });
  }
  return row;
}

function versionValues(version: RoleVersion): unknown[] {
  return [
    version.roleId,
    version.version,
    version.id,
    version.status,
    JSON.stringify(version.definition),
    version.definitionDigest,
    version.createdAt,
    JSON.stringify(version.createdBy),
    version.changeNote,
    version.evidence ? JSON.stringify(version.evidence) : null,
    version.restoredFromVersion ?? null,
    version.rolledOffAt ?? null,
  ];
}

/**
 * Turn a unique-constraint violation into the rule it actually broke.
 *
 * The index names carry the meaning; a bare "duplicate key value violates
 * unique constraint" tells whoever hit it nothing about which of the two rules
 * they crossed.
 */
function translateRoleConflict(error: unknown, name: string): unknown {
  const code = (error as { code?: string } | null)?.code;
  const constraint = (error as { constraint?: string } | null)?.constraint ?? "";
  if (code !== "23505") return error;

  if (constraint.includes("identity")) {
    return new InvalidInputError(
      `Role "${name}" has the same actions, risk ceiling, data scopes, and model task as an existing role, differing only in prompt wording. If two roles differ only in prompt wording, they are one role.`,
      "identityDigest",
    );
  }
  return new InvalidInputError(
    `Role name "${name}" is already in use. The name is how workflows, operators, and containment switches refer to a role, so two roles cannot share one.`,
    "name",
  );
}

function toRole(row: RoleRow): Role {
  return {
    id: row.id as Id<"role">,
    name: row.name,
    createdAt: row.created_at,
    createdBy: row.created_by,
    latestVersion: Number(row.latest_version),
    promotedVersion: row.promoted_version === null ? undefined : Number(row.promoted_version),
    identityDigest: row.identity_digest as Digest,
  };
}

function toVersion(row: VersionRow): RoleVersion {
  return {
    id: row.id as Id<"roleVersion">,
    roleId: row.role_id as Id<"role">,
    version: Number(row.version),
    status: row.status as RoleStatus,
    definition: row.definition,
    definitionDigest: row.definition_digest as Digest,
    createdAt: row.created_at,
    createdBy: row.created_by,
    changeNote: row.change_note,
    evidence: row.evidence ?? undefined,
    restoredFromVersion: row.restored_from === null ? undefined : Number(row.restored_from),
    rolledOffAt: row.rolled_off_at ?? undefined,
  };
}

function toGoldenSet(row: GoldenSetRow): GoldenSet {
  return {
    id: row.id,
    version: Number(row.version),
    task: row.task,
    synthetic: row.synthetic,
    // numeric arrives as a string; comparing it as one against a measured
    // accuracy would compare lexicographically and pass for the wrong reason.
    threshold: Number(row.threshold),
    curatedBy: row.curated_by,
    curatedAt: row.curated_at,
    cases: row.cases,
  };
}

function toEvaluation(row: EvaluationRow): EvaluationRun {
  return {
    id: row.id as Id<"evaluation">,
    roleId: row.role_id as Id<"role">,
    roleVersion: Number(row.role_version),
    definitionDigest: row.definition_digest as Digest,
    goldenSetId: row.golden_set_id,
    goldenSetVersion: Number(row.golden_set_version),
    goldenSetDigest: row.golden_set_digest as Digest,
    task: row.task,
    modelId: row.model_id,
    modelVersion: row.model_version,
    promptTemplateId: row.prompt_template_id,
    promptTemplateVersion: Number(row.prompt_template_version),
    runId: row.run_id as Id<"run">,
    evaluatedBy: row.evaluated_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    caseCount: Number(row.case_count),
    passed: Number(row.passed),
    failed: Number(row.failed),
    errored: Number(row.errored),
    accuracy: Number(row.accuracy),
    threshold: Number(row.threshold),
    meetsThreshold: row.meets_threshold,
    syntheticFixtures: row.synthetic_fixtures,
    results: row.results,
    totalCostUsd: Number(row.total_cost_usd),
  };
}
