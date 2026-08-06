import type { Id } from "../kernel/ids.js";
import type { IsoTimestamp } from "../record/types.js";
import type {
  EvaluationFilter,
  EvaluationRun,
  GoldenSet,
  PromotionEvidence,
  Role,
  RoleStatus,
  RoleVersion,
} from "./types.js";

/**
 * Persistence ports for role governance.
 *
 * Three operations here carry requirements a caller cannot meet with a read
 * followed by a write, so they are expressed as single atomic operations and
 * implemented as such in both adapters.
 *
 *   `appendVersion` assigns the version number under a lock. Two authors
 *   editing the same role at once must produce v4 and v5, not two v4s — one of
 *   which would silently overwrite the other's attribution.
 *
 *   `promoteVersion` is a compare-and-set. Promotion is the moment a role
 *   becomes able to act, and two promotions racing must not both win: the
 *   loser's approval was granted against a different starting state. The
 *   method takes the promoted version the caller believed was current and
 *   returns `null` when that is no longer true, exactly as approval
 *   consumption does.
 *
 *   `setVersionStatus` is the same shape for the kill switch and the lifecycle
 *   moves. It carries the status the caller expects to find, so a disable
 *   racing a promotion cannot silently disable the wrong version.
 *
 * Golden sets are write-once per `(id, version)`. There is no update path and
 * no delete path, because the protection guard in evaluation.ts is only
 * meaningful if the ground truth of record cannot be edited in place. A repeat
 * of an identical write is a no-op (the crash-and-recover path); a repeat with
 * different content is refused.
 *
 * As everywhere else: a read that cannot be served raises rather than
 * returning empty. "This role has no evaluations" and "we cannot tell what
 * evaluations this role has" lead to opposite decisions about promoting it.
 */

export interface PromoteResult {
  readonly role: Role;
  readonly version: RoleVersion;
  /** The version that was rolled off to make room, when there was one. */
  readonly rolledOff?: RoleVersion | undefined;
}

export interface RoleStore {
  /**
   * Create a role and its first version together.
   *
   * Atomic: a role with no versions would be a name reservation nobody can
   * use, and a version with no role would be unreachable.
   *
   * @throws {InvalidInputError} when the name is taken, or when another role
   *   already carries the same identity digest — two roles differing only in
   *   prompt wording are one role.
   */
  createRole(role: Role, firstVersion: RoleVersion): Promise<PromoteResult>;

  getRole(id: Id<"role">): Promise<Role | null>;
  /** @throws {DeniedError} `record.unavailable` when the role is absent. */
  requireRole(id: Id<"role">): Promise<Role>;
  findRoleByName(name: string): Promise<Role | null>;
  listRoles(): Promise<readonly Role[]>;

  /**
   * Append a new version, assigning its number atomically.
   *
   * The role's `identityDigest` moves with the newest version, so the
   * cross-role uniqueness rule keeps applying as definitions change.
   */
  appendVersion(
    version: Omit<RoleVersion, "version">,
    identityDigest: string,
  ): Promise<{ readonly role: Role; readonly version: RoleVersion }>;

  getVersion(roleId: Id<"role">, version: number): Promise<RoleVersion | null>;
  /** @throws {DeniedError} `record.unavailable` when the version is absent. */
  requireVersion(roleId: Id<"role">, version: number): Promise<RoleVersion>;
  listVersions(roleId: Id<"role">): Promise<readonly RoleVersion[]>;
  /** The version that may act, if any. Read on the authorization path. */
  promotedVersion(roleId: Id<"role">): Promise<RoleVersion | null>;

  /**
   * Make `version` the promoted one, rolling off whatever held that place.
   *
   * @returns `null` when `expectedPromotedVersion` no longer matches what is
   *   stored, meaning another promotion won the race and this caller's
   *   approval was granted against a state that no longer exists.
   */
  promoteVersion(input: {
    readonly roleId: Id<"role">;
    readonly version: number;
    readonly evidence: PromotionEvidence;
    readonly at: IsoTimestamp;
    /** What the caller believes is promoted now; `undefined` means nothing is. */
    readonly expectedPromotedVersion: number | undefined;
  }): Promise<PromoteResult | null>;

  /**
   * Move a version between lifecycle states.
   *
   * @returns `null` when the version is not in `expectedStatus`, so a disable
   *   that raced a promotion refuses rather than acting on stale state.
   */
  setVersionStatus(input: {
    readonly roleId: Id<"role">;
    readonly version: number;
    readonly expectedStatus: RoleStatus;
    readonly nextStatus: RoleStatus;
    readonly at: IsoTimestamp;
  }): Promise<{ readonly role: Role; readonly version: RoleVersion } | null>;
}

export interface EvaluationStore {
  /**
   * Store a curated golden set.
   *
   * Identical content under the same `(id, version)` is a no-op. Different
   * content is refused: the ground truth of record does not change under an
   * identifier someone has already cited.
   */
  putGoldenSet(set: GoldenSet): Promise<GoldenSet>;
  /** Highest version when `version` is omitted. */
  getGoldenSet(id: string, version?: number): Promise<GoldenSet | null>;
  /** @throws {DeniedError} `record.unavailable` when the set is absent. */
  requireGoldenSet(id: string, version?: number): Promise<GoldenSet>;
  listGoldenSets(): Promise<readonly GoldenSet[]>;

  /** Append-only. An evaluation run is evidence and is never edited. */
  recordEvaluation(run: EvaluationRun): Promise<EvaluationRun>;
  getEvaluation(id: Id<"evaluation">): Promise<EvaluationRun | null>;
  listEvaluations(filter?: EvaluationFilter): Promise<readonly EvaluationRun[]>;
  /** Most recent run for a role version, for the console and for regression checks. */
  latestEvaluation(roleId: Id<"role">, roleVersion?: number): Promise<EvaluationRun | null>;
}
