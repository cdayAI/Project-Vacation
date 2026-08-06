import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { Authorizer } from "../guard/authorize.js";
import type { ActionRegistry } from "../guard/registry.js";
import type { HumanInvolvement, RiskTier } from "../guard/types.js";
import { RISK_TIERS } from "../guard/types.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import type { Id, IdGenerator } from "../kernel/ids.js";
import { OPERATING_MODES, type ActorRef, type OperatingMode } from "../record/types.js";
import { REVERT_ROLE_ACTION } from "./actions.js";
import type { RoleStore } from "./port.js";
import {
  RISK_RANK,
  type Role,
  type RoleChange,
  type RoleDefinition,
  type RoleVersion,
} from "./types.js";

/**
 * The role registry: versioned, diffable, attributable, revertible.
 *
 * Adding a role is meant to be a business change rather than an engineering
 * one. That only stays safe if every change to a role is still treated as a
 * change to the system's behaviour, so four properties are built into the
 * write path rather than left to process.
 *
 * *Versioned.* There is no update path for a definition. Editing a role means
 * appending a version; the previous one stays exactly as it was, which is what
 * makes "what was this role allowed to do in March" answerable.
 *
 * *Attributable.* Every version carries the actor who wrote it, when, and why.
 * A change note is required rather than optional — a diff with no stated
 * reason is a diff an approver has to guess about.
 *
 * *Diffable.* `diff()` produces a change list the console renders, with the
 * changes that widen authority marked so they are read first. A diff that
 * buries "gained the ability to message owners" in a list of wording edits is
 * a diff that gets approved without being read.
 *
 * *Revertible.* `revert()` restores a version that was previously promoted,
 * carrying its original evidence forward. It refuses to restore anything that
 * was never promoted, which is what stops revert from being a promotion with
 * the approval gate removed.
 *
 * Roles are few and purposeful. `createRole` refuses a role that differs from
 * an existing one only in prompt wording — see `roleIdentity` below.
 */

const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const SCOPE_PATTERN = /^[a-z][a-z0-9_-]*(:[a-z0-9_-]+)*$/;
const MAX_PURPOSE_LENGTH = 1_000;
const MAX_CHANGE_NOTE_LENGTH = 1_000;
/**
 * A role that may call fifty different actions is not a role, it is a login.
 * The cap is generous for anything purposeful and hostile to a catalogue.
 */
const MAX_ACTIONS_PER_ROLE = 12;

const INVOLVEMENT_STRICTNESS: Readonly<Record<HumanInvolvement, number>> = {
  automatic: 0,
  proposed_then_approved: 1,
  human_only: 2,
};

/**
 * What makes one role distinct from another.
 *
 * Covers the actions it may call, the risk it may reach, the data it may see,
 * and the model task it resolves — and deliberately **not** the prompt, the
 * name, or the purpose text.
 *
 * If two roles differ only in prompt wording, they are one role. Two entries
 * with identical authority and different phrasing produce two audit trails,
 * two evaluation sets, two things to disable in an incident, and one shared
 * blast radius — all of the cost of separation with none of the containment.
 * The registry refuses the second one and the database refuses it again.
 */
export function roleIdentity(definition: RoleDefinition): Digest {
  return digestValue({
    actions: [...definition.actions].sort(),
    riskCeiling: definition.riskCeiling,
    dataScopes: [...definition.dataScopes].sort(),
    modelTask: definition.modelTask,
  });
}

/** Fingerprint of the whole definition, bound into approvals and evidence. */
export function definitionDigest(definition: RoleDefinition): Digest {
  return digestValue(normalise(definition));
}

/**
 * Validate a definition.
 *
 * @throws {InvalidInputError} on anything structurally or governance-wise
 *   incoherent. Every check here would otherwise surface as a confusing
 *   refusal at the authorization chokepoint, long after the person who wrote
 *   the role has moved on.
 */
export function assertDefinition(
  definition: RoleDefinition,
  actions: ActionRegistry,
): void {
  if (!ROLE_NAME_PATTERN.test(definition.name)) {
    throw new InvalidInputError(
      `Role name "${definition.name}" must be lower_snake_case, e.g. "rescission_intake".`,
      "name",
    );
  }
  const purpose = definition.purpose?.trim() ?? "";
  if (purpose.length === 0 || purpose.length > MAX_PURPOSE_LENGTH) {
    throw new InvalidInputError(
      `Role "${definition.name}" needs a purpose of 1 to ${MAX_PURPOSE_LENGTH} characters. An approver reads this to decide whether the role should exist.`,
      "purpose",
    );
  }

  if (definition.riskCeiling === "prohibited") {
    // A prohibited action is refused to everyone, whatever the configuration
    // says. A role claiming that ceiling is claiming authority nobody has, and
    // it is cheaper to refuse the claim than to rely on every call being caught.
    throw new InvalidInputError(
      `Role "${definition.name}" declares a "prohibited" risk ceiling. Prohibited actions are refused to every caller; no role may claim them.`,
      "riskCeiling",
    );
  }
  if (!RISK_TIERS.includes(definition.riskCeiling)) {
    throw new InvalidInputError(
      `Role "${definition.name}" declares an unknown risk ceiling "${definition.riskCeiling}".`,
      "riskCeiling",
    );
  }

  if (definition.actions.length === 0) {
    throw new InvalidInputError(
      `Role "${definition.name}" declares no actions, so it could never do anything.`,
      "actions",
    );
  }
  if (definition.actions.length > MAX_ACTIONS_PER_ROLE) {
    throw new InvalidInputError(
      `Role "${definition.name}" declares ${definition.actions.length} actions, past the limit of ${MAX_ACTIONS_PER_ROLE}. Roles are few and purposeful; a role this broad should be several roles or none.`,
      "actions",
    );
  }
  if (new Set(definition.actions).size !== definition.actions.length) {
    throw new InvalidInputError(
      `Role "${definition.name}" lists the same action more than once.`,
      "actions",
    );
  }

  const ceilingRank = RISK_RANK[definition.riskCeiling];
  let strictestRequired: HumanInvolvement = "automatic";

  for (const name of definition.actions) {
    // `require` refuses an action that is not in the registry, which is what
    // stops a role from inventing capability: it selects from what the
    // platform has already declared it can do.
    const descriptor = actions.require(name);
    if (RISK_RANK[descriptor.risk] > ceilingRank) {
      throw new InvalidInputError(
        `Role "${definition.name}" declares action "${name}" (${descriptor.risk}) but a risk ceiling of "${definition.riskCeiling}". The ceiling has to cover what the role says it does, or the role could never perform its own actions.`,
        "riskCeiling",
      );
    }
    if (
      INVOLVEMENT_STRICTNESS[descriptor.humanInvolvement] >
      INVOLVEMENT_STRICTNESS[strictestRequired]
    ) {
      strictestRequired = descriptor.humanInvolvement;
    }
  }

  if (INVOLVEMENT_STRICTNESS[definition.humanTier] < INVOLVEMENT_STRICTNESS[strictestRequired]) {
    // The role may be stricter than its actions require. It may not be laxer:
    // a role declaring "automatic" while holding an action that needs an
    // approval would be a written claim that contradicts the chokepoint.
    throw new InvalidInputError(
      `Role "${definition.name}" declares human involvement "${definition.humanTier}", weaker than the "${strictestRequired}" its actions require.`,
      "humanTier",
    );
  }

  for (const scope of definition.dataScopes) {
    if (!SCOPE_PATTERN.test(scope)) {
      throw new InvalidInputError(
        `Role "${definition.name}" declares an unusable data scope "${scope}". Scopes look like "legal" or "association:0142".`,
        "dataScopes",
      );
    }
  }
  if (new Set(definition.dataScopes).size !== definition.dataScopes.length) {
    throw new InvalidInputError(
      `Role "${definition.name}" lists the same data scope more than once.`,
      "dataScopes",
    );
  }

  for (const [field, value] of [
    ["modelTask", definition.modelTask],
    ["promptTemplateId", definition.promptTemplateId],
    ["evaluationSetId", definition.evaluationSetId],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new InvalidInputError(`Role "${definition.name}" needs a ${field}.`, field);
    }
  }
  if (
    !Number.isInteger(definition.promptTemplateVersion) ||
    definition.promptTemplateVersion < 1
  ) {
    throw new InvalidInputError(
      `Role "${definition.name}" needs a positive promptTemplateVersion. Evidence has to name the exact prompt it ran against.`,
      "promptTemplateVersion",
    );
  }

  if (definition.operatingModes.length === 0) {
    throw new InvalidInputError(
      `Role "${definition.name}" declares no operating modes, so it could never run.`,
      "operatingModes",
    );
  }
  for (const mode of definition.operatingModes) {
    if (!OPERATING_MODES.includes(mode)) {
      throw new InvalidInputError(
        `Role "${definition.name}" declares an unknown operating mode "${mode}".`,
        "operatingModes",
      );
    }
  }
}

export interface CreateRoleInput {
  readonly definition: RoleDefinition;
  readonly author: ActorRef;
  readonly changeNote: string;
}

export interface NewVersionInput {
  readonly roleId: Id<"role">;
  readonly definition: RoleDefinition;
  readonly author: ActorRef;
  readonly changeNote: string;
}

export interface RevertInput {
  readonly roleId: Id<"role">;
  /** The version to restore. Must have been promoted at some point. */
  readonly toVersion: number;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  /** Why the rollback is happening. Recorded on the restoring version. */
  readonly reason: string;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

/**
 * Drafting is deliberately not gated here.
 *
 * A draft cannot act — there is no status transition from `draft` to acting
 * that does not pass through `promotion.ts` — so creating one has no effect on
 * the world, and the API applies its own access control before anything
 * reaches this class. The gated moments are the ones that change what the
 * platform will do: propose, promote, revert, and disable.
 */
export class RoleRegistry {
  constructor(
    private readonly store: RoleStore,
    private readonly actions: ActionRegistry,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly audit: AuditLog,
    private readonly authorizer: Authorizer,
  ) {}

  /**
   * Create a role and its first version.
   *
   * The first version is a `draft`. There is no argument that makes it
   * anything else — promotion is a separate, evidenced, approved operation.
   *
   * @throws {InvalidInputError} when the definition is incoherent, the name is
   *   taken, or an existing role has the same authority and differs only in
   *   prompt wording.
   */
  async createRole(input: CreateRoleInput): Promise<{ role: Role; version: RoleVersion }> {
    assertDefinition(input.definition, this.actions);
    const changeNote = assertChangeNote(input.changeNote);

    const identity = roleIdentity(input.definition);

    // Checked here for a message that explains the rule, and again in the store
    // under a lock so two concurrent creations cannot both pass. The readable
    // error is this one; the unconditional guarantee is the store's.
    const existing = await this.store.listRoles();
    const twin = existing.find((role) => role.identityDigest === identity);
    if (twin) {
      throw new InvalidInputError(
        `Role "${input.definition.name}" has the same actions, risk ceiling, data scopes, and model task as the existing role "${twin.name}", differing only in prompt wording. If two roles differ only in prompt wording, they are one role — add a version to "${twin.name}" instead.`,
        "definition",
      );
    }

    const now = this.clock.nowIso();
    const roleId = this.ids.next("role");
    const role: Role = {
      id: roleId,
      name: input.definition.name,
      createdAt: now,
      createdBy: input.author,
      latestVersion: 1,
      promotedVersion: undefined,
      identityDigest: identity,
    };
    const version: RoleVersion = {
      id: this.ids.next("roleVersion"),
      roleId,
      version: 1,
      status: "draft",
      definition: normalise(input.definition),
      definitionDigest: definitionDigest(input.definition),
      createdAt: now,
      createdBy: input.author,
      changeNote,
    };

    const created = await this.store.createRole(role, version);

    await this.audit.record(
      auditDecision({
        eventType: "role.proposed",
        actorId: input.author.actorId,
        actorKind: input.author.kind,
        actorRoles: input.author.roles,
        subject: { roleId: created.role.id, roleName: created.role.name, roleVersion: "1" },
        inputDigests: { definition: version.definitionDigest, identity },
        decision: {
          status: "draft",
          actions: input.definition.actions.join(","),
          riskCeiling: input.definition.riskCeiling,
          humanTier: input.definition.humanTier,
          modelTask: input.definition.modelTask,
          changeNote: changeNote.slice(0, 512),
        },
      }),
    );

    return { role: created.role, version: created.version };
  }

  /**
   * Append a new version of an existing role.
   *
   * Always a `draft`, whatever the previous version's status. Editing a live
   * role does not change what is live: the promoted version keeps acting until
   * a new one is promoted on its own evidence.
   */
  async createVersion(input: NewVersionInput): Promise<{ role: Role; version: RoleVersion }> {
    assertDefinition(input.definition, this.actions);
    const changeNote = assertChangeNote(input.changeNote);

    const role = await this.store.requireRole(input.roleId);
    if (input.definition.name !== role.name) {
      // The name is the handle operators, workflows, and containment switches
      // use. Renaming through a version would silently orphan every reference.
      throw new InvalidInputError(
        `Role ${role.id} is named "${role.name}"; version ${role.latestVersion + 1} declares "${input.definition.name}". A role's name is how everything else refers to it and does not change across versions.`,
        "name",
      );
    }

    const identity = roleIdentity(input.definition);
    const others = (await this.store.listRoles()).filter((entry) => entry.id !== role.id);
    const twin = others.find((entry) => entry.identityDigest === identity);
    if (twin) {
      throw new InvalidInputError(
        `This version of "${role.name}" would have the same actions, risk ceiling, data scopes, and model task as the role "${twin.name}". If two roles differ only in prompt wording, they are one role.`,
        "definition",
      );
    }

    const now = this.clock.nowIso();
    const appended = await this.store.appendVersion(
      {
        id: this.ids.next("roleVersion"),
        roleId: role.id,
        status: "draft",
        definition: normalise(input.definition),
        definitionDigest: definitionDigest(input.definition),
        createdAt: now,
        createdBy: input.author,
        changeNote,
      },
      identity,
    );

    const previous = await this.store.getVersion(role.id, appended.version.version - 1);
    const changes = previous ? diff(previous.definition, input.definition) : [];

    await this.audit.record(
      auditDecision({
        eventType: "role.proposed",
        actorId: input.author.actorId,
        actorKind: input.author.kind,
        actorRoles: input.author.roles,
        subject: {
          roleId: role.id,
          roleName: role.name,
          roleVersion: String(appended.version.version),
        },
        inputDigests: { definition: appended.version.definitionDigest, identity },
        decision: {
          status: "draft",
          changes: changes.length,
          widensAuthority: changes.some((change) => change.widensAuthority),
          changeNote: changeNote.slice(0, 512),
        },
      }),
    );

    return appended;
  }

  get(roleId: Id<"role">): Promise<Role | null> {
    return this.store.getRole(roleId);
  }

  require(roleId: Id<"role">): Promise<Role> {
    return this.store.requireRole(roleId);
  }

  findByName(name: string): Promise<Role | null> {
    return this.store.findRoleByName(name);
  }

  list(): Promise<readonly Role[]> {
    return this.store.listRoles();
  }

  versions(roleId: Id<"role">): Promise<readonly RoleVersion[]> {
    return this.store.listVersions(roleId);
  }

  version(roleId: Id<"role">, version: number): Promise<RoleVersion | null> {
    return this.store.getVersion(roleId, version);
  }

  /** The version that may act, if any. */
  promoted(roleId: Id<"role">): Promise<RoleVersion | null> {
    return this.store.promotedVersion(roleId);
  }

  /**
   * Roll a role back to a version that was previously promoted.
   *
   * Reverting appends a *new* version restoring the old definition rather than
   * resurrecting the old row. The history stays append-only, so "we rolled back
   * to v2 on the 14th" is a fact in the record rather than an absence of one.
   *
   * The restored version carries the original version's evidence forward — the
   * evaluation run that measured it and the approval that authorised it — with
   * the rollback's own actor and timestamp. That is honest: this exact
   * definition was evidenced and approved once, and nothing about it has
   * changed since.
   *
   * Two refusals matter more than the mechanics:
   *
   *   A version that was **never promoted** cannot be reverted to. Without
   *   that rule, revert would be a promotion with the evidence requirement and
   *   the approval gate removed, and anyone who could revert could ship an
   *   unevaluated role by drafting it and then "rolling back" to it.
   *
   *   The authorization request deliberately does **not** set `roleId`. That
   *   field means "this role is acting", and it is what the per-role
   *   containment switch is checked against. A human rolling back a role is
   *   not the role acting — and if it were treated as such, the one operation
   *   most needed after disabling a misbehaving role would be refused because
   *   the role is disabled.
   *
   * @throws {DeniedError} `role.not_promoted` when the target was never
   *   promoted, or any denial raised by the authorization chokepoint.
   */
  async revert(input: RevertInput): Promise<{ role: Role; version: RoleVersion }> {
    const role = await this.store.requireRole(input.roleId);
    const target = await this.store.requireVersion(input.roleId, input.toVersion);

    if (!target.evidence) {
      throw new DeniedError(
        "role.not_promoted",
        `Version ${input.toVersion} of role "${role.name}" was never promoted, so there is no state to roll back to. Reverting to an unevaluated version would be a promotion with the evidence requirement removed.`,
        { roleId: role.id, version: input.toVersion, status: target.status },
      );
    }

    const current = await this.store.promotedVersion(role.id);
    if (current?.version === input.toVersion) {
      throw new InvalidInputError(
        `Version ${input.toVersion} of role "${role.name}" is already the promoted version.`,
        "toVersion",
      );
    }

    const reason = assertChangeNote(input.reason);
    const identity = roleIdentity(target.definition);

    await this.authorizer.authorize({
      action: REVERT_ROLE_ACTION,
      actor: input.actor,
      mode: input.mode,
      correlationId: input.correlationId,
      subject: {
        roleId: role.id,
        roleName: role.name,
        toVersion: String(input.toVersion),
      },
      secondsSinceAuthentication: input.secondsSinceAuthentication,
    });

    const now = this.clock.nowIso();
    const appended = await this.store.appendVersion(
      {
        id: this.ids.next("roleVersion"),
        roleId: role.id,
        status: "draft",
        definition: target.definition,
        definitionDigest: target.definitionDigest,
        createdAt: now,
        createdBy: input.actor,
        changeNote: reason,
        restoredFromVersion: input.toVersion,
      },
      identity,
    );

    const promoted = await this.store.promoteVersion({
      roleId: role.id,
      version: appended.version.version,
      evidence: {
        ...target.evidence,
        promotedAt: now,
        promotedBy: input.actor,
      },
      at: now,
      expectedPromotedVersion: current?.version,
    });

    if (!promoted) {
      // Another promotion or rollback moved the role while this one was in
      // flight. The restoring version stays in the record as a draft — visible,
      // harmless, and honest about what was attempted.
      throw new DeniedError(
        "record.unavailable",
        `Role "${role.name}" changed while this rollback was in flight; version ${appended.version.version} was left as a draft rather than promoted over whatever is now live.`,
        { roleId: role.id, version: appended.version.version },
      );
    }

    await this.audit.record(
      auditDecision({
        eventType: "role.reverted",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        correlationId: input.correlationId,
        subject: {
          roleId: role.id,
          roleName: role.name,
          roleVersion: String(promoted.version.version),
        },
        inputDigests: { definition: promoted.version.definitionDigest },
        decision: {
          restoredFromVersion: input.toVersion,
          rolledOffVersion: current?.version ?? 0,
          evaluationRunId: target.evidence.evaluationRunId,
          approvalId: target.evidence.approvalId,
          reason: reason.slice(0, 512),
        },
      }),
    );

    return { role: promoted.role, version: promoted.version };
  }

  /** Diff two stored versions, newest-relative: what `to` changed from `from`. */
  async diffVersions(
    roleId: Id<"role">,
    fromVersion: number,
    toVersion: number,
  ): Promise<readonly RoleChange[]> {
    const from = await this.store.requireVersion(roleId, fromVersion);
    const to = await this.store.requireVersion(roleId, toVersion);
    return diff(from.definition, to.definition);
  }
}

/**
 * What changed between two definitions.
 *
 * `widensAuthority` marks a change that increases what the role may do **or
 * reduces what it must prove**. Both belong in the same bucket because both
 * are ways to get more latitude past a reviewer: adding an action is the
 * obvious one, and swapping the evaluation set for an easier one is the
 * subtle one.
 */
export function diff(from: RoleDefinition, to: RoleDefinition): readonly RoleChange[] {
  const changes: RoleChange[] = [];

  for (const action of to.actions) {
    if (!from.actions.includes(action)) {
      changes.push({
        field: "actions",
        kind: "added",
        to: action,
        widensAuthority: true,
        summary: `gains the action "${action}"`,
      });
    }
  }
  for (const action of from.actions) {
    if (!to.actions.includes(action)) {
      changes.push({
        field: "actions",
        kind: "removed",
        from: action,
        widensAuthority: false,
        summary: `loses the action "${action}"`,
      });
    }
  }

  if (from.riskCeiling !== to.riskCeiling) {
    const widens = RISK_RANK[to.riskCeiling] > RISK_RANK[from.riskCeiling];
    changes.push({
      field: "riskCeiling",
      kind: "changed",
      from: from.riskCeiling,
      to: to.riskCeiling,
      widensAuthority: widens,
      summary: `risk ceiling ${widens ? "raised" : "lowered"} from ${from.riskCeiling} to ${to.riskCeiling}`,
    });
  }

  for (const scope of to.dataScopes) {
    if (!from.dataScopes.includes(scope)) {
      changes.push({
        field: "dataScopes",
        kind: "added",
        to: scope,
        widensAuthority: true,
        summary: `gains access to data scope "${scope}"`,
      });
    }
  }
  for (const scope of from.dataScopes) {
    if (!to.dataScopes.includes(scope)) {
      changes.push({
        field: "dataScopes",
        kind: "removed",
        from: scope,
        widensAuthority: false,
        summary: `loses access to data scope "${scope}"`,
      });
    }
  }

  if (from.humanTier !== to.humanTier) {
    const widens = INVOLVEMENT_STRICTNESS[to.humanTier] < INVOLVEMENT_STRICTNESS[from.humanTier];
    changes.push({
      field: "humanTier",
      kind: "changed",
      from: from.humanTier,
      to: to.humanTier,
      widensAuthority: widens,
      summary: `human involvement ${widens ? "weakened" : "strengthened"} from ${from.humanTier} to ${to.humanTier}`,
    });
  }

  for (const mode of to.operatingModes) {
    if (!from.operatingModes.includes(mode)) {
      changes.push({
        field: "operatingModes",
        kind: "added",
        to: mode,
        // Every added mode is a mode the role could not previously run in.
        // `bounded_autonomy` is the one that matters most, and it is not
        // singled out here: the console shows the mode name.
        widensAuthority: mode !== "shadow",
        summary: `may now run in ${mode} mode`,
      });
    }
  }
  for (const mode of from.operatingModes) {
    if (!to.operatingModes.includes(mode)) {
      changes.push({
        field: "operatingModes",
        kind: "removed",
        from: mode,
        widensAuthority: false,
        summary: `no longer runs in ${mode} mode`,
      });
    }
  }

  if (from.modelTask !== to.modelTask) {
    changes.push({
      field: "modelTask",
      kind: "changed",
      from: from.modelTask,
      to: to.modelTask,
      // A different task resolves to a different model, prompt, and data
      // classification. The role's evidence no longer describes what will run.
      widensAuthority: true,
      summary: `model task changed from "${from.modelTask}" to "${to.modelTask}", so its evidence describes a different system`,
    });
  }

  if (
    from.promptTemplateId !== to.promptTemplateId ||
    from.promptTemplateVersion !== to.promptTemplateVersion
  ) {
    changes.push({
      field: "prompt",
      kind: "changed",
      from: `${from.promptTemplateId} v${from.promptTemplateVersion}`,
      to: `${to.promptTemplateId} v${to.promptTemplateVersion}`,
      widensAuthority: false,
      summary: `prompt changed from ${from.promptTemplateId} v${from.promptTemplateVersion} to ${to.promptTemplateId} v${to.promptTemplateVersion}`,
    });
  }

  if (from.evaluationSetId !== to.evaluationSetId) {
    changes.push({
      field: "evaluationSetId",
      kind: "changed",
      from: from.evaluationSetId,
      to: to.evaluationSetId,
      widensAuthority: true,
      summary: `measured against a different golden set ("${from.evaluationSetId}" to "${to.evaluationSetId}"), so its quality claim rests on different ground truth`,
    });
  }

  if (from.purpose !== to.purpose) {
    changes.push({
      field: "purpose",
      kind: "changed",
      from: from.purpose,
      to: to.purpose,
      widensAuthority: false,
      summary: "purpose reworded",
    });
  }

  if (from.name !== to.name) {
    changes.push({
      field: "name",
      kind: "changed",
      from: from.name,
      to: to.name,
      widensAuthority: false,
      summary: `renamed from "${from.name}" to "${to.name}"`,
    });
  }

  // Widening changes first, then by field, so the console does not have to
  // re-sort and an approver reads the consequential lines at the top.
  return changes.sort((left, right) => {
    if (left.widensAuthority !== right.widensAuthority) return left.widensAuthority ? -1 : 1;
    if (left.field !== right.field) return left.field < right.field ? -1 : 1;
    return left.summary < right.summary ? -1 : 1;
  });
}

/** Copy a definition into a canonical shape so digests are order-independent. */
function normalise(definition: RoleDefinition): RoleDefinition {
  return {
    name: definition.name,
    purpose: definition.purpose.trim(),
    actions: [...definition.actions].sort(),
    riskCeiling: definition.riskCeiling,
    dataScopes: [...definition.dataScopes].sort(),
    modelTask: definition.modelTask,
    promptTemplateId: definition.promptTemplateId,
    promptTemplateVersion: definition.promptTemplateVersion,
    evaluationSetId: definition.evaluationSetId,
    humanTier: definition.humanTier,
    operatingModes: sortModes(definition.operatingModes),
  };
}

function sortModes(modes: readonly OperatingMode[]): readonly OperatingMode[] {
  return [...modes].sort(
    (left, right) => OPERATING_MODES.indexOf(left) - OPERATING_MODES.indexOf(right),
  );
}

function assertChangeNote(note: string): string {
  const trimmed = typeof note === "string" ? note.trim() : "";
  if (trimmed.length === 0 || trimmed.length > MAX_CHANGE_NOTE_LENGTH) {
    throw new InvalidInputError(
      `A role version needs a change note of 1 to ${MAX_CHANGE_NOTE_LENGTH} characters. A change with no stated reason is a change an approver has to guess about.`,
      "changeNote",
    );
  }
  return trimmed;
}

/** Re-exported so callers comparing tiers do not reach into guard directly. */
export type { RiskTier };
