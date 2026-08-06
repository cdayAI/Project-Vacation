import { canonicalJson } from "../kernel/canonical.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { isDigest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import { assertIsoUtc, assertOptionalIsoUtc } from "../record/migrations.js";
import type { MemoryDb } from "../store/db.js";
import type { EvaluationStore, PromoteResult, RoleStore } from "./port.js";
import {
  PROMOTABLE_STATUSES,
  ROLE_STATUSES,
  type EvaluationFilter,
  type EvaluationRun,
  type GoldenSet,
  type Role,
  type RoleVersion,
} from "./types.js";

/**
 * In-memory role governance.
 *
 * Held to the same contract as the Postgres adapter, including the parts that
 * are inconvenient to fake.
 *
 * Every mutating operation takes one named lock rather than a per-role one.
 * That is coarser than the row locking Postgres does, and deliberately so: the
 * uniqueness rules here are *cross-role* — one name, one identity digest — so
 * a per-role lock would not serialise the writes that can actually collide. A
 * fake that was more permissive under concurrency than the real thing is a
 * fake that lets a test pass on code Postgres would reject.
 *
 * The validation below duplicates the CHECK constraints in `migrations.ts` on
 * purpose, for the same reason.
 *
 * One divergence, stated rather than hidden: Postgres carries a foreign key
 * from `role_evaluation_run.run_id` to `run`, and this adapter does not check
 * that the operating-record run exists. Reaching into another module's
 * in-memory tables to imitate the constraint would couple this store to the
 * operating record's table names. In practice the harness always runs inside a
 * run; a test that records an evaluation against an invented run id will pass
 * here and fail against Postgres.
 */

const ROLES = "agent_role";
const VERSIONS = "agent_role_version";
const GOLDEN_SETS = "role_golden_set";
const EVALUATIONS = "role_evaluation_run";

/** One lock for every role mutation. See the class comment. */
const ROLE_LOCK = "roles:write";

function versionKey(roleId: string, version: number): string {
  return `${roleId}#${version}`;
}

export class MemoryRoleStore implements RoleStore {
  constructor(private readonly db: MemoryDb) {}

  async createRole(role: Role, firstVersion: RoleVersion): Promise<PromoteResult> {
    assertRole(role);
    assertVersion(firstVersion);
    if (firstVersion.roleId !== role.id) {
      throw new InvalidInputError(
        `The first version names role ${firstVersion.roleId}, not ${role.id}.`,
        "roleId",
      );
    }
    if (firstVersion.version !== 1) {
      throw new InvalidInputError(
        `A role's first version is version 1, not ${firstVersion.version}.`,
        "version",
      );
    }

    return this.db.withLock(ROLE_LOCK, async () => {
      const roles = this.db.table<Role>(ROLES);
      if (roles.has(role.id)) {
        throw new InvalidInputError(`Role ${role.id} already exists.`, "id");
      }
      for (const existing of roles.values()) {
        if (existing.name === role.name) {
          throw new InvalidInputError(
            `Role name "${role.name}" is already in use by ${existing.id}. The name is how workflows, operators, and containment switches refer to a role, so two roles cannot share one.`,
            "name",
          );
        }
        if (existing.identityDigest === role.identityDigest) {
          throw new InvalidInputError(
            `Role "${role.name}" has the same actions, risk ceiling, data scopes, and model task as "${existing.name}". If two roles differ only in prompt wording, they are one role.`,
            "identityDigest",
          );
        }
      }

      roles.set(role.id, structuredClone(role));
      this.db
        .table<RoleVersion>(VERSIONS)
        .set(versionKey(role.id, 1), structuredClone(firstVersion));
      return { role: structuredClone(role), version: structuredClone(firstVersion) };
    });
  }

  async getRole(id: Id<"role">): Promise<Role | null> {
    const found = this.db.table<Role>(ROLES).get(id);
    return found ? structuredClone(found) : null;
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
    for (const role of this.db.rows<Role>(ROLES)) {
      if (role.name === name) return structuredClone(role);
    }
    return null;
  }

  async listRoles(): Promise<readonly Role[]> {
    return this.db
      .rows<Role>(ROLES)
      .slice()
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      .map((role) => structuredClone(role));
  }

  async appendVersion(
    version: Omit<RoleVersion, "version">,
    identityDigest: string,
  ): Promise<{ role: Role; version: RoleVersion }> {
    if (!isDigest(identityDigest)) {
      throw new InvalidInputError(`identityDigest must be a sha256 digest.`, "identityDigest");
    }

    return this.db.withLock(ROLE_LOCK, async () => {
      const roles = this.db.table<Role>(ROLES);
      const role = roles.get(version.roleId);
      if (!role) {
        throw new DeniedError(
          "record.unavailable",
          `Role ${version.roleId} is not in the role registry.`,
          { roleId: version.roleId },
        );
      }
      for (const existing of roles.values()) {
        if (existing.id !== role.id && existing.identityDigest === identityDigest) {
          throw new InvalidInputError(
            `This version of "${role.name}" would have the same authority as the role "${existing.name}". If two roles differ only in prompt wording, they are one role.`,
            "identityDigest",
          );
        }
      }

      // Assigned here rather than by the caller, so two authors editing the
      // same role concurrently produce v4 and v5 rather than two v4s, one of
      // which would overwrite the other's attribution.
      const next = role.latestVersion + 1;
      const stored: RoleVersion = { ...version, version: next };
      assertVersion(stored);

      this.db.table<RoleVersion>(VERSIONS).set(versionKey(role.id, next), structuredClone(stored));
      const updated: Role = { ...role, latestVersion: next, identityDigest };
      roles.set(role.id, structuredClone(updated));

      return { role: structuredClone(updated), version: structuredClone(stored) };
    });
  }

  async getVersion(roleId: Id<"role">, version: number): Promise<RoleVersion | null> {
    const found = this.db.table<RoleVersion>(VERSIONS).get(versionKey(roleId, version));
    return found ? structuredClone(found) : null;
  }

  async requireVersion(roleId: Id<"role">, version: number): Promise<RoleVersion> {
    const found = await this.getVersion(roleId, version);
    if (!found) {
      throw new DeniedError(
        "record.unavailable",
        `Role ${roleId} has no version ${version}.`,
        { roleId, version },
      );
    }
    return found;
  }

  async listVersions(roleId: Id<"role">): Promise<readonly RoleVersion[]> {
    return this.db
      .rows<RoleVersion>(VERSIONS)
      .filter((entry) => entry.roleId === roleId)
      .sort((left, right) => left.version - right.version)
      .map((entry) => structuredClone(entry));
  }

  async promotedVersion(roleId: Id<"role">): Promise<RoleVersion | null> {
    // Read from the version rows rather than the role's pointer. The pointer is
    // a convenience; the status is the fact, and the Postgres adapter enforces
    // "at most one promoted" on the status with a unique index.
    for (const entry of this.db.rows<RoleVersion>(VERSIONS)) {
      if (entry.roleId === roleId && entry.status === "promoted") return structuredClone(entry);
    }
    return null;
  }

  async promoteVersion(input: {
    readonly roleId: Id<"role">;
    readonly version: number;
    readonly evidence: RoleVersion["evidence"];
    readonly at: string;
    readonly expectedPromotedVersion: number | undefined;
  }): Promise<PromoteResult | null> {
    assertIsoUtc("at", input.at);
    if (!input.evidence) {
      throw new InvalidInputError(
        "A version cannot be promoted without the evaluation run and approval that justified it.",
        "evidence",
      );
    }

    return this.db.withLock(ROLE_LOCK, async () => {
      const roles = this.db.table<Role>(ROLES);
      const versions = this.db.table<RoleVersion>(VERSIONS);
      const role = roles.get(input.roleId);
      if (!role) {
        throw new DeniedError(
          "record.unavailable",
          `Role ${input.roleId} is not in the role registry.`,
          { roleId: input.roleId },
        );
      }
      const target = versions.get(versionKey(input.roleId, input.version));
      if (!target) {
        throw new DeniedError(
          "record.unavailable",
          `Role ${input.roleId} has no version ${input.version}.`,
          { roleId: input.roleId, version: input.version },
        );
      }
      if (!PROMOTABLE_STATUSES.includes(target.status)) {
        throw new InvalidInputError(
          `Version ${input.version} of role "${role.name}" is ${target.status} and cannot be promoted.`,
          "version",
        );
      }

      let current: RoleVersion | undefined;
      for (const entry of versions.values()) {
        if (entry.roleId === input.roleId && entry.status === "promoted") {
          current = entry;
          break;
        }
      }

      // Compare-and-set. A promotion approved against one starting state must
      // not land on a different one: the loser's approver never saw what is
      // there now.
      if (current?.version !== input.expectedPromotedVersion) return null;

      if (current) {
        const rolledOff: RoleVersion = {
          ...current,
          status: "reverted",
          rolledOffAt: input.at,
        };
        versions.set(versionKey(input.roleId, current.version), structuredClone(rolledOff));
      }

      const promoted: RoleVersion = {
        ...target,
        status: "promoted",
        evidence: structuredClone(input.evidence),
        rolledOffAt: undefined,
      };
      assertVersion(promoted);
      versions.set(versionKey(input.roleId, input.version), structuredClone(promoted));

      const updatedRole: Role = { ...role, promotedVersion: input.version };
      roles.set(role.id, structuredClone(updatedRole));

      return {
        role: structuredClone(updatedRole),
        version: structuredClone(promoted),
        rolledOff: current
          ? structuredClone({ ...current, status: "reverted", rolledOffAt: input.at })
          : undefined,
      };
    });
  }

  async setVersionStatus(input: {
    readonly roleId: Id<"role">;
    readonly version: number;
    readonly expectedStatus: RoleVersion["status"];
    readonly nextStatus: RoleVersion["status"];
    readonly at: string;
  }): Promise<{ role: Role; version: RoleVersion } | null> {
    assertIsoUtc("at", input.at);

    return this.db.withLock(ROLE_LOCK, async () => {
      const roles = this.db.table<Role>(ROLES);
      const versions = this.db.table<RoleVersion>(VERSIONS);
      const role = roles.get(input.roleId);
      if (!role) {
        throw new DeniedError(
          "record.unavailable",
          `Role ${input.roleId} is not in the role registry.`,
          { roleId: input.roleId },
        );
      }
      const target = versions.get(versionKey(input.roleId, input.version));
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
        for (const entry of versions.values()) {
          if (
            entry.roleId === input.roleId &&
            entry.status === "promoted" &&
            entry.version !== input.version
          ) {
            // Mirrors the unique partial index in Postgres.
            return null;
          }
        }
      }

      const moved: RoleVersion = {
        ...target,
        status: input.nextStatus,
        rolledOffAt:
          input.nextStatus === "promoted"
            ? undefined
            : target.status === "promoted"
              ? input.at
              : target.rolledOffAt,
      };
      assertVersion(moved);
      versions.set(versionKey(input.roleId, input.version), structuredClone(moved));

      const promotedNow = input.nextStatus === "promoted";
      const wasPointer = role.promotedVersion === input.version;
      const updatedRole: Role = {
        ...role,
        promotedVersion: promotedNow
          ? input.version
          : wasPointer
            ? undefined
            : role.promotedVersion,
      };
      roles.set(role.id, structuredClone(updatedRole));

      return { role: structuredClone(updatedRole), version: structuredClone(moved) };
    });
  }
}

export class MemoryEvaluationStore implements EvaluationStore {
  constructor(private readonly db: MemoryDb) {}

  async putGoldenSet(set: GoldenSet): Promise<GoldenSet> {
    assertGoldenSetRow(set);

    return this.db.withLock(`roles:golden:${set.id}:${set.version}`, async () => {
      const table = this.db.table<GoldenSet>(GOLDEN_SETS);
      const key = `${set.id}@${set.version}`;
      const existing = table.get(key);
      if (existing) {
        // A repeat of an identical write is the crash-and-recover path. A
        // repeat with different content is an in-place edit of ground truth
        // that has already been cited by an evaluation run, and is refused.
        if (canonicalJson(existing) === canonicalJson(set)) return structuredClone(existing);
        throw new DeniedError(
          "record.unavailable",
          `Golden set "${set.id}" v${set.version} already exists with different content. A curated set is immutable once published; publish a new version instead.`,
          { goldenSetId: set.id, version: set.version },
        );
      }
      table.set(key, structuredClone(set));
      return structuredClone(set);
    });
  }

  async getGoldenSet(id: string, version?: number): Promise<GoldenSet | null> {
    if (version !== undefined) {
      const found = this.db.table<GoldenSet>(GOLDEN_SETS).get(`${id}@${version}`);
      return found ? structuredClone(found) : null;
    }
    let latest: GoldenSet | undefined;
    for (const set of this.db.rows<GoldenSet>(GOLDEN_SETS)) {
      if (set.id !== id) continue;
      if (!latest || set.version > latest.version) latest = set;
    }
    return latest ? structuredClone(latest) : null;
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
    return this.db
      .rows<GoldenSet>(GOLDEN_SETS)
      .slice()
      .sort((left, right) =>
        left.id !== right.id ? (left.id < right.id ? -1 : 1) : left.version - right.version,
      )
      .map((set) => structuredClone(set));
  }

  async recordEvaluation(run: EvaluationRun): Promise<EvaluationRun> {
    assertEvaluationRow(run);

    return this.db.withLock(`roles:evaluation:${run.id}`, async () => {
      const table = this.db.table<EvaluationRun>(EVALUATIONS);
      const existing = table.get(run.id);
      if (existing) {
        if (canonicalJson(existing) === canonicalJson(run)) return structuredClone(existing);
        throw new DeniedError(
          "record.unavailable",
          `Evaluation run ${run.id} already exists with different results. Evidence whose numbers can be rewritten afterwards is not evidence.`,
          { evaluationRunId: run.id },
        );
      }
      table.set(run.id, structuredClone(run));
      return structuredClone(run);
    });
  }

  async getEvaluation(id: Id<"evaluation">): Promise<EvaluationRun | null> {
    const found = this.db.table<EvaluationRun>(EVALUATIONS).get(id);
    return found ? structuredClone(found) : null;
  }

  async listEvaluations(filter: EvaluationFilter = {}): Promise<readonly EvaluationRun[]> {
    const rows = this.db.rows<EvaluationRun>(EVALUATIONS);
    const ordinals = new Map(rows.map((row, index) => [row.id, index]));
    const matched = rows.filter((row) => {
      if (filter.roleId !== undefined && row.roleId !== filter.roleId) return false;
      if (filter.roleVersion !== undefined && row.roleVersion !== filter.roleVersion) return false;
      if (filter.goldenSetId !== undefined && row.goldenSetId !== filter.goldenSetId) return false;
      if (filter.meetsThreshold !== undefined && row.meetsThreshold !== filter.meetsThreshold) {
        return false;
      }
      return true;
    });

    // Newest first, insertion order as the tiebreak. Under a fixed clock every
    // run in a test shares a `completedAt`, so without the tiebreak the order
    // would depend on sort stability rather than on anything real.
    matched.sort((left, right) => {
      if (left.completedAt !== right.completedAt) return left.completedAt < right.completedAt ? 1 : -1;
      return (ordinals.get(right.id) ?? 0) - (ordinals.get(left.id) ?? 0);
    });

    const from = filter.offset ?? 0;
    const to = filter.limit === undefined ? matched.length : from + filter.limit;
    return matched.slice(from, to).map((row) => structuredClone(row));
  }

  async latestEvaluation(
    roleId: Id<"role">,
    roleVersion?: number,
  ): Promise<EvaluationRun | null> {
    const matched = await this.listEvaluations({ roleId, roleVersion, limit: 1 });
    return matched[0] ?? null;
  }
}

function assertRole(role: Role): void {
  assertIsoUtc("createdAt", role.createdAt);
  if (!/^[a-z][a-z0-9_]*$/.test(role.name)) {
    throw new InvalidInputError(`Role name "${role.name}" must be lower_snake_case.`, "name");
  }
  if (!isDigest(role.identityDigest)) {
    throw new InvalidInputError(`Role "${role.name}" needs a sha256 identity digest.`, "identityDigest");
  }
  if (!Number.isInteger(role.latestVersion) || role.latestVersion < 1) {
    throw new InvalidInputError(`Role "${role.name}" needs a positive latestVersion.`, "latestVersion");
  }
}

function assertVersion(version: RoleVersion): void {
  assertIsoUtc("createdAt", version.createdAt);
  assertOptionalIsoUtc("rolledOffAt", version.rolledOffAt);
  if (!ROLE_STATUSES.includes(version.status)) {
    throw new InvalidInputError(`Unknown role version status "${version.status}".`, "status");
  }
  if (!Number.isInteger(version.version) || version.version < 1) {
    throw new InvalidInputError(`A role version number must be a positive integer.`, "version");
  }
  if (!isDigest(version.definitionDigest)) {
    throw new InvalidInputError(`A role version needs a sha256 definition digest.`, "definitionDigest");
  }
  const note = version.changeNote ?? "";
  if (note.length < 1 || note.length > 1_000) {
    throw new InvalidInputError(
      `A role version needs a change note of 1 to 1000 characters.`,
      "changeNote",
    );
  }
  if (version.status === "promoted" && !version.evidence) {
    // The same constraint the schema enforces. A promoted version with no
    // evidence would be a role acting on nobody's decision.
    throw new InvalidInputError(
      `Version ${version.version} cannot be promoted without the evaluation run and approval that justified it.`,
      "evidence",
    );
  }
  if ((version.status === "disabled" || version.status === "reverted") && !version.evidence) {
    throw new InvalidInputError(
      `Version ${version.version} is ${version.status}, which only a promoted version becomes, so it must carry the evidence it was promoted on.`,
      "evidence",
    );
  }
  if (version.evidence) assertIsoUtc("evidence.promotedAt", version.evidence.promotedAt);
}

function assertGoldenSetRow(set: GoldenSet): void {
  assertIsoUtc("curatedAt", set.curatedAt);
  if (!Number.isInteger(set.version) || set.version < 1) {
    throw new InvalidInputError(`Golden set "${set.id}" needs a positive version.`, "version");
  }
  if (set.threshold < 0 || set.threshold > 1) {
    throw new InvalidInputError(
      `Golden set "${set.id}" needs a threshold between 0 and 1.`,
      "threshold",
    );
  }
  if (set.cases.length === 0) {
    throw new InvalidInputError(
      `Golden set "${set.id}" has no cases, so a run against it would establish nothing while reporting perfect accuracy.`,
      "cases",
    );
  }
  if ((set.curatedBy ?? "").trim().length === 0) {
    throw new InvalidInputError(
      `Golden set "${set.id}" needs to name who curated it.`,
      "curatedBy",
    );
  }
  for (const entry of set.cases) {
    assertIsoUtc(`cases.${entry.id}.curatedAt`, entry.curatedAt);
    if (
      !set.synthetic &&
      entry.protectedAttributes &&
      Object.keys(entry.protectedAttributes).length > 0
    ) {
      throw new InvalidInputError(
        `Case "${entry.id}" in golden set "${set.id}" carries protected-class attributes on a set that is not marked synthetic.`,
        "protectedAttributes",
      );
    }
  }
}

function assertEvaluationRow(run: EvaluationRun): void {
  assertIsoUtc("startedAt", run.startedAt);
  assertIsoUtc("completedAt", run.completedAt);
  if (!isDigest(run.definitionDigest) || !isDigest(run.goldenSetDigest)) {
    throw new InvalidInputError(
      `Evaluation run ${run.id} needs sha256 digests binding it to what it measured.`,
      "definitionDigest",
    );
  }
  if (run.accuracy < 0 || run.accuracy > 1 || run.threshold < 0 || run.threshold > 1) {
    throw new InvalidInputError(
      `Evaluation run ${run.id} has an accuracy or threshold outside [0, 1].`,
      "accuracy",
    );
  }
  if (run.passed + run.failed + run.errored !== run.caseCount) {
    // A run reporting 40 passes out of 30 cases is not evidence, it is a bug
    // with a number attached.
    throw new InvalidInputError(
      `Evaluation run ${run.id} reports ${run.passed}+${run.failed}+${run.errored} outcomes across ${run.caseCount} cases. The parts have to add up to the whole.`,
      "caseCount",
    );
  }
  if (run.results.length !== run.caseCount) {
    throw new InvalidInputError(
      `Evaluation run ${run.id} reports ${run.caseCount} cases but carries ${run.results.length} results.`,
      "results",
    );
  }
  if (run.totalCostUsd < 0) {
    throw new InvalidInputError(
      `Evaluation run ${run.id} reports a negative cost.`,
      "totalCostUsd",
    );
  }
}
