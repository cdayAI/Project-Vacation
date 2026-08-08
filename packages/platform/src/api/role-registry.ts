import type { Platform } from "../platform.js";
import type { EvaluationRun, Role, RoleVersion } from "../roles/types.js";

/**
 * The role registry, as the console lists and reads it.
 *
 * A role here is what MVW adds when it wants the platform to do a new job. The
 * console shows two things over the same view model: the registry (one row per
 * role, its current version) and a role's history (every version, newest
 * first). They are the same shape on purpose — a role's "current state" is
 * simply its highest-numbered version — so there is no second type to keep in
 * step with the first.
 *
 * **What the record sources, and what it does not.** Everything a `RoleView`
 * carries about the role itself — its purpose, its ceiling, the actions it may
 * call, who last changed it — is on the versioned artifact, which is the record
 * of the change. The one field that costs a second read is `latestEvaluation`:
 * quality is measured, never asserted, so a role that has never been evaluated
 * carries no evaluation here rather than a reassuring blank. "Not measured" and
 * "measured and failing" lead a reviewer to different decisions, and the two
 * are kept distinct — the field is absent for the first and present for the
 * second.
 *
 * The registry row uses the promoted version when there is one and the newest
 * version otherwise. A role whose latest version is a draft is shown as that
 * draft, because the alternative — showing a promoted version that has been
 * superseded — would tell a reviewer the role is doing something it no longer
 * does.
 */

export interface EvaluationView {
  readonly evaluationId: string;
  readonly ranAt: string;
  readonly goldenSetName: string;
  readonly caseCount: number;
  readonly passed: number;
  readonly accuracy: number;
  readonly threshold: number;
  readonly meetsThreshold: boolean;
  readonly modelId: string;
  readonly promptVersion: string;
}

export interface RoleView {
  readonly roleId: string;
  readonly name: string;
  readonly purpose: string;
  readonly version: number;
  readonly status: RoleVersion["status"];
  readonly riskCeiling: RoleVersion["definition"]["riskCeiling"];
  readonly humanInvolvement: string;
  readonly modelTask: string;
  readonly allowedActions: readonly string[];
  readonly dataScopes: readonly string[];
  readonly updatedAt: string;
  readonly updatedBy: { readonly actorId: string; readonly displayName: string; readonly roles: readonly string[] };
  readonly latestEvaluation?: EvaluationView | undefined;
  readonly disabled: boolean;
}

/** Map an evaluation run to the console's view model. Measured, never asserted. */
export function evaluationView(run: EvaluationRun): EvaluationView {
  return {
    evaluationId: run.id,
    ranAt: run.completedAt,
    goldenSetName: run.goldenSetId,
    caseCount: run.caseCount,
    passed: run.passed,
    accuracy: run.accuracy,
    threshold: run.threshold,
    meetsThreshold: run.meetsThreshold,
    modelId: run.modelId,
    // The prompt the evidence ran against, named so a reviewer can find the
    // exact artifact in version control rather than a floating "latest".
    promptVersion: `${run.promptTemplateId}@${run.promptTemplateVersion}`,
  };
}

/** Map a role and one of its versions to a `RoleView`, attaching its evaluation. */
export async function roleView(
  platform: Platform,
  role: Role,
  version: RoleVersion,
): Promise<RoleView> {
  const evaluation = await platform.evaluations.latestEvaluation(role.id, version.version);
  return {
    roleId: role.id,
    name: role.name,
    purpose: version.definition.purpose,
    version: version.version,
    status: version.status,
    riskCeiling: version.definition.riskCeiling,
    humanInvolvement: version.definition.humanTier,
    modelTask: version.definition.modelTask,
    allowedActions: [...version.definition.actions],
    dataScopes: [...version.definition.dataScopes],
    updatedAt: version.createdAt,
    updatedBy: {
      actorId: version.createdBy.actorId,
      displayName: version.createdBy.actorId,
      roles: version.createdBy.roles,
    },
    latestEvaluation: evaluation ? evaluationView(evaluation) : undefined,
    disabled: version.status === "disabled",
  };
}

/**
 * The version the registry row should show: the promoted one, or the newest.
 *
 * Returns `null` only for a role with no versions at all, which the store
 * refuses to create — an atomic `createRole` writes the head and its first
 * version together — so in practice a role always resolves to a version.
 */
async function representativeVersion(
  platform: Platform,
  role: Role,
): Promise<RoleVersion | null> {
  const promoted = await platform.roleStore.promotedVersion(role.id);
  if (promoted) return promoted;
  return platform.roleStore.getVersion(role.id, role.latestVersion);
}

/** Every role, one row each, as a page of `RoleView`. */
export async function roleRegistryPage(
  platform: Platform,
  limit: number,
  offset: number,
): Promise<{
  readonly items: readonly RoleView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}> {
  const all = await platform.roleStore.listRoles();
  // Ordered by name so the registry is stable between reads and a link to a row
  // resolves to the same row tomorrow.
  const ordered = [...all].sort((left, right) => left.name.localeCompare(right.name));
  const window = ordered.slice(offset, offset + limit);

  const items: RoleView[] = [];
  for (const role of window) {
    const version = await representativeVersion(platform, role);
    // A role the store somehow holds with no resolvable version is dropped
    // rather than shown as a half-record; the store's atomic create makes this
    // unreachable, and dropping it is safer than inventing a version number.
    if (version) items.push(await roleView(platform, role, version));
  }

  return { items, total: ordered.length, limit, offset };
}

/**
 * Every version of one role, newest first, each as a `RoleView`.
 *
 * Returns `null` when the role does not exist, so the route can answer 404
 * rather than an empty page — "this role has no versions" and "there is no such
 * role" are different facts, and a supervisor acts differently on each.
 */
export async function roleVersionsPage(
  platform: Platform,
  roleId: Role["id"],
): Promise<{
  readonly items: readonly RoleView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
} | null> {
  const role = await platform.roleStore.getRole(roleId);
  if (!role) return null;

  const versions = await platform.roleStore.listVersions(roleId);
  const ordered = [...versions].sort((left, right) => right.version - left.version);
  const items = await Promise.all(ordered.map((version) => roleView(platform, role, version)));

  return { items, total: items.length, limit: items.length, offset: 0 };
}
