import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { ApprovalService } from "../guard/approvals.js";
import type { Authorizer } from "../guard/authorize.js";
import type { ContainmentController } from "../guard/containment.js";
import type { ActionRegistry } from "../guard/registry.js";
import type { ActionRequest, ApprovalRequest, AuthorizationGrant, ContainmentSwitch } from "../guard/types.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { ModelInventory } from "../models/inventory.js";
import type { PromptTemplateRegistry } from "../models/templates.js";
import type { ActorRef, OperatingMode } from "../record/types.js";
import { PROMOTE_ROLE_ACTION, PROPOSE_ROLE_ACTION } from "./actions.js";
import type { EvaluationStore, RoleStore } from "./port.js";
import {
  PROMOTABLE_STATUSES,
  RISK_RANK,
  type EvaluationRun,
  type PromotionEvidence,
  type Role,
  type RoleVersion,
} from "./types.js";

/**
 * Promotion: the only path from a definition to a role that can act.
 *
 * Promotion requires evidence. Not a claim that the role was tested — the
 * identifier of the run that tested it, the cases it ran, the model and prompt
 * it ran against, and the numbers it produced. Then a human with authority
 * approves through the existing chokepoint and the existing approval service,
 * which are not reimplemented here: `role.promote` is `high_consequence` in the
 * action catalogue, so it carries an approval bound to a proposal digest,
 * segregation of duties, single use, and step-up re-authentication for free.
 *
 * The evidence checks are all forms of one question: *does this evidence
 * describe the thing that is about to run?*
 *
 *   the same role and version      evidence for v3 does not promote v4
 *   the same definition digest     a definition edited after the evaluation is
 *                                  a different definition
 *   the declared golden set        measuring against an easier set and
 *                                  promoting against the declared one is the
 *                                  obvious way to launder a weak result
 *   the same model and prompt      an inventory or template change since the
 *                                  evaluation means the evidence describes a
 *                                  system that no longer exists
 *   above the threshold            measured, not asserted
 *
 * After promotion, `authorizeRoleAction` is how the role acts, and it enforces
 * the declared ceilings before the general chokepoint runs. A role that has
 * not been promoted throws `role.not_promoted`; a role asked to exceed its
 * declared risk ceiling throws `role.ceiling_exceeded`.
 */

export interface PromotionProposal {
  readonly roleId: Id<"role">;
  readonly version: number;
  readonly definitionDigest: Digest;
  readonly evaluationRunId: Id<"evaluation">;
  readonly goldenSetDigest: Digest;
  readonly accuracy: number;
  readonly threshold: number;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly promptTemplateId: string;
  readonly promptTemplateVersion: number;
}

/**
 * The digest an approver's decision is bound to.
 *
 * Covers the definition *and* the evidence. Binding to the definition alone
 * would leave the evidence swappable after sign-off: approve v4 on the
 * strength of a 97% run, then promote v4 citing a different run. Both halves
 * are what the approver was shown, so both halves are in the digest.
 */
export function promotionProposalDigest(proposal: PromotionProposal): Digest {
  return digestValue({
    kind: "role.promotion",
    roleId: proposal.roleId,
    version: proposal.version,
    definitionDigest: proposal.definitionDigest,
    evaluationRunId: proposal.evaluationRunId,
    goldenSetDigest: proposal.goldenSetDigest,
    accuracy: proposal.accuracy,
    threshold: proposal.threshold,
    modelId: proposal.modelId,
    modelVersion: proposal.modelVersion,
    promptTemplateId: proposal.promptTemplateId,
    promptTemplateVersion: proposal.promptTemplateVersion,
  });
}

export interface ProposeInput {
  readonly roleId: Id<"role">;
  readonly version: number;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export interface RequestPromotionInput {
  readonly roleId: Id<"role">;
  readonly version: number;
  readonly evaluationRunId: Id<"evaluation">;
  readonly requestedBy: ActorRef;
  /** Roles eligible to approve. Drawn from the action descriptor by default. */
  readonly eligibleRoles?: readonly string[] | undefined;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly ttlMs?: number | undefined;
}

export interface PromoteInput {
  readonly roleId: Id<"role">;
  readonly version: number;
  readonly evaluationRunId: Id<"evaluation">;
  readonly approvalId: Id<"approval">;
  readonly actor: ActorRef;
  readonly mode: OperatingMode;
  readonly runId?: Id<"run"> | undefined;
  readonly correlationId?: string | undefined;
  readonly secondsSinceAuthentication?: number | undefined;
}

export interface DisableInput {
  readonly roleId: Id<"role">;
  readonly actor: ActorRef;
  readonly reason: string;
}

export interface EnableInput {
  readonly roleId: Id<"role">;
  /** The disabled version to bring back. Named explicitly, never guessed. */
  readonly version: number;
  readonly actor: ActorRef;
  readonly reason: string;
}

/** An action request from a role, before the role's own bounds are applied. */
export interface RoleActionRequest extends Omit<ActionRequest, "roleId"> {
  readonly roleId: Id<"role">;
}

export interface RolePromotionDependencies {
  readonly roles: RoleStore;
  readonly evaluations: EvaluationStore;
  readonly actions: ActionRegistry;
  readonly authorizer: Authorizer;
  readonly approvals: ApprovalService;
  readonly containment: ContainmentController;
  readonly inventory: ModelInventory;
  readonly templates: PromptTemplateRegistry;
  readonly audit: AuditLog;
  readonly clock: Clock;
}

export class RolePromotionService {
  constructor(private readonly deps: RolePromotionDependencies) {}

  /**
   * Submit a drafted version for promotion.
   *
   * Changes nothing about what can act. It exists so the queue an approver
   * works from is a queue of things someone deliberately put on it, rather
   * than every draft anyone has ever saved.
   */
  async propose(input: ProposeInput): Promise<RoleVersion> {
    const role = await this.deps.roles.requireRole(input.roleId);
    const version = await this.deps.roles.requireVersion(input.roleId, input.version);
    if (version.status !== "draft") {
      throw new InvalidInputError(
        `Version ${input.version} of role "${role.name}" is ${version.status}, not a draft.`,
        "version",
      );
    }

    await this.deps.authorizer.authorize({
      action: PROPOSE_ROLE_ACTION,
      actor: input.actor,
      mode: input.mode,
      correlationId: input.correlationId,
      subject: {
        roleId: role.id,
        roleName: role.name,
        roleVersion: String(input.version),
      },
      secondsSinceAuthentication: input.secondsSinceAuthentication,
    });

    const moved = await this.deps.roles.setVersionStatus({
      roleId: role.id,
      version: input.version,
      expectedStatus: "draft",
      nextStatus: "proposed",
      at: this.deps.clock.nowIso(),
    });
    if (!moved) {
      throw new DeniedError(
        "record.unavailable",
        `Version ${input.version} of role "${role.name}" was changed by someone else while this proposal was in flight.`,
        { roleId: role.id, version: input.version },
      );
    }

    await this.deps.audit.record(
      auditDecision({
        eventType: "role.proposed",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        correlationId: input.correlationId,
        subject: {
          roleId: role.id,
          roleName: role.name,
          roleVersion: String(input.version),
        },
        inputDigests: { definition: version.definitionDigest },
        decision: { status: "proposed" },
      }),
    );

    return moved.version;
  }

  /**
   * Raise the approval an approver will decide on.
   *
   * Provided here so the proposal digest is computed in one place. A caller
   * assembling it by hand would eventually assemble it slightly differently,
   * and the mismatch would surface as an unexplainable refusal at promotion
   * time rather than as the bug it is.
   */
  async requestPromotionApproval(input: RequestPromotionInput): Promise<ApprovalRequest> {
    const role = await this.deps.roles.requireRole(input.roleId);
    const version = await this.deps.roles.requireVersion(input.roleId, input.version);
    const evidence = await this.requireEvidence(role, version, input.evaluationRunId);
    const descriptor = this.deps.actions.require(PROMOTE_ROLE_ACTION);

    const changes = version.definition;
    return this.deps.approvals.request({
      action: PROMOTE_ROLE_ACTION,
      proposalDigest: promotionProposalDigest(toProposal(version, evidence)),
      summary:
        `Promote role "${role.name}" v${version.version} so it may act. ` +
        `Actions: ${changes.actions.join(", ")}. Risk ceiling: ${changes.riskCeiling}. ` +
        `Human involvement: ${changes.humanTier}. ` +
        `Evaluated at ${(evidence.accuracy * 100).toFixed(1)}% against ${evidence.caseCount} case(s) ` +
        `in "${evidence.goldenSetId}" v${evidence.goldenSetVersion} (threshold ${(evidence.threshold * 100).toFixed(1)}%).`,
      requestedBy: input.requestedBy,
      approvalsRequired: descriptor.approvalsRequired,
      eligibleRoles: input.eligibleRoles ?? descriptor.allowedRoles,
      runId: input.runId,
      correlationId: input.correlationId,
      subject: {
        roleId: role.id,
        roleName: role.name,
        roleVersion: String(version.version),
        evaluationRunId: evidence.id,
      },
      ttlMs: input.ttlMs,
    });
  }

  /**
   * Promote a version so it may act.
   *
   * @throws {DeniedError} `record.unavailable` when there is no evidence,
   *   `approval.digest_mismatch` when the evidence describes something other
   *   than what is about to run, `improvement.evaluation_regression` when the
   *   measured quality is below the golden set's threshold, and anything the
   *   authorization chokepoint raises — including `approval.required` when no
   *   human has approved.
   */
  async promote(input: PromoteInput): Promise<{ role: Role; version: RoleVersion }> {
    const role = await this.deps.roles.requireRole(input.roleId);
    const version = await this.deps.roles.requireVersion(input.roleId, input.version);

    if (!PROMOTABLE_STATUSES.includes(version.status)) {
      throw new InvalidInputError(
        `Version ${input.version} of role "${role.name}" is ${version.status} and cannot be promoted. A disabled or rolled-off version is restored with revert(), and a live one is replaced by a new version.`,
        "version",
      );
    }

    const evidence = await this.requireEvidence(role, version, input.evaluationRunId);
    this.assertEvidenceDescribesWhatWillRun(role, version, evidence);

    if (!evidence.meetsThreshold) {
      throw new DeniedError(
        "improvement.evaluation_regression",
        `Role "${role.name}" v${version.version} measured ${(evidence.accuracy * 100).toFixed(1)}% against a threshold of ${(evidence.threshold * 100).toFixed(1)}%. Quality is measured, not asserted, and this did not clear the bar.`,
        {
          roleId: role.id,
          version: version.version,
          accuracy: evidence.accuracy,
          threshold: evidence.threshold,
        },
      );
    }
    if (evidence.errored > 0) {
      // Errored cases measured nothing. Promoting on a run that fell over
      // halfway would be promoting on a number that describes less work than
      // it appears to.
      throw new DeniedError(
        "improvement.evaluation_regression",
        `Evaluation run ${evidence.id} had ${evidence.errored} errored case(s), so it did not measure what it claims to. Re-run it before promoting.`,
        { roleId: role.id, evaluationRunId: evidence.id, errored: evidence.errored },
      );
    }

    const current = await this.deps.roles.promotedVersion(role.id);

    // The chokepoint consumes the approval, checks step-up, records the
    // decision, and refuses if any of it does not hold. `roleId` is
    // deliberately absent: that field means "this role is acting", and a human
    // promoting a role is not the role acting. Setting it would make the
    // per-role containment switch block the promotion of an unrelated version.
    await this.deps.authorizer.authorize({
      action: PROMOTE_ROLE_ACTION,
      actor: input.actor,
      mode: input.mode,
      runId: input.runId,
      correlationId: input.correlationId,
      approvalId: input.approvalId,
      proposalDigest: promotionProposalDigest(toProposal(version, evidence)),
      subject: {
        roleId: role.id,
        roleName: role.name,
        roleVersion: String(version.version),
        evaluationRunId: evidence.id,
      },
      secondsSinceAuthentication: input.secondsSinceAuthentication,
    });

    const now = this.deps.clock.nowIso();
    const promotionEvidence: PromotionEvidence = {
      evaluationRunId: evidence.id,
      accuracy: evidence.accuracy,
      threshold: evidence.threshold,
      approvalId: input.approvalId,
      promotedAt: now,
      promotedBy: input.actor,
      modelId: evidence.modelId,
      modelVersion: evidence.modelVersion,
      promptTemplateId: evidence.promptTemplateId,
      promptTemplateVersion: evidence.promptTemplateVersion,
    };

    const promoted = await this.deps.roles.promoteVersion({
      roleId: role.id,
      version: version.version,
      evidence: promotionEvidence,
      at: now,
      expectedPromotedVersion: current?.version,
    });

    if (!promoted) {
      // The approval has already been consumed at this point, and that is the
      // right trade: an approval is single-use precisely so a decision cannot
      // be replayed against a state the approver never saw. The losing promoter
      // raises a fresh approval against the state that actually exists.
      throw new DeniedError(
        "record.unavailable",
        `Role "${role.name}" was promoted by another operator while this promotion was in flight, so this one was refused rather than applied over a state its approver never saw.`,
        { roleId: role.id, version: version.version },
      );
    }

    await this.deps.audit.record(
      auditDecision({
        eventType: "role.promoted",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        runId: input.runId,
        correlationId: input.correlationId,
        subject: {
          roleId: role.id,
          roleName: role.name,
          roleVersion: String(version.version),
          evaluationRunId: evidence.id,
        },
        inputDigests: {
          definition: version.definitionDigest,
          goldenSet: evidence.goldenSetDigest,
        },
        decision: {
          approvalId: input.approvalId,
          accuracy: evidence.accuracy,
          threshold: evidence.threshold,
          cases: evidence.caseCount,
          actions: version.definition.actions.join(","),
          riskCeiling: version.definition.riskCeiling,
          humanTier: version.definition.humanTier,
          modelId: evidence.modelId,
          modelVersion: evidence.modelVersion,
          promptTemplateId: evidence.promptTemplateId,
          promptTemplateVersion: evidence.promptTemplateVersion,
          rolledOffVersion: current?.version ?? 0,
        },
      }),
    );

    return { role: promoted.role, version: promoted.version };
  }

  /**
   * Stop a role, now, without a deploy.
   *
   * The containment switch is engaged **first**. It is the authoritative
   * control — the authorization chokepoint checks it on every action, so an
   * in-flight run stops at its next action boundary rather than only being
   * prevented from starting. Flipping the version status first and then
   * failing to engage the switch would leave a role that looks disabled in the
   * console and is still acting; doing it in this order means a failure
   * anywhere after the switch leaves the role stopped.
   *
   * Authorization for `containment.engage` belongs at the API boundary, as it
   * does for every other containment engagement. It is deliberately not
   * applied here: a stop button that refuses because a larger stop button is
   * already pressed is a stop button with a trap in it.
   */
  async disable(
    input: DisableInput,
  ): Promise<{ readonly switch: ContainmentSwitch; readonly version: RoleVersion | null }> {
    const role = await this.deps.roles.requireRole(input.roleId);

    const engaged = await this.deps.containment.engage(
      "role",
      role.id,
      input.actor.actorId,
      input.reason,
    );

    const promoted = await this.deps.roles.promotedVersion(role.id);
    let disabled: RoleVersion | null = null;
    if (promoted) {
      const moved = await this.deps.roles.setVersionStatus({
        roleId: role.id,
        version: promoted.version,
        expectedStatus: "promoted",
        nextStatus: "disabled",
        at: this.deps.clock.nowIso(),
      });
      disabled = moved?.version ?? null;
    }

    await this.deps.audit.record(
      auditDecision({
        eventType: "role.disabled",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        subject: {
          roleId: role.id,
          roleName: role.name,
          roleVersion: promoted ? String(promoted.version) : "none",
        },
        decision: {
          reason: input.reason.slice(0, 512),
          containmentEngaged: engaged.engaged,
          versionDisabled: disabled !== null,
        },
      }),
    );

    return { switch: engaged, version: disabled };
  }

  /**
   * Bring a disabled version back.
   *
   * The reverse order of `disable`, for the same reason: the status is
   * restored first and the switch released last, so a failure part-way leaves
   * the role stopped rather than running.
   *
   * No fresh approval is required — this version was evidenced and approved
   * when it was promoted, and nothing about it has changed. The operator's
   * reason is recorded.
   */
  async enable(
    input: EnableInput,
  ): Promise<{ readonly switch: ContainmentSwitch; readonly version: RoleVersion }> {
    const role = await this.deps.roles.requireRole(input.roleId);
    const version = await this.deps.roles.requireVersion(input.roleId, input.version);

    if (version.status !== "disabled") {
      throw new InvalidInputError(
        `Version ${input.version} of role "${role.name}" is ${version.status}, not disabled.`,
        "version",
      );
    }
    if (!version.evidence) {
      // Belt and braces: a disabled version reached that state from `promoted`,
      // which the schema will not allow without evidence. If one ever appeared
      // without it, restoring it would be a promotion with no evidence at all.
      throw new DeniedError(
        "role.not_promoted",
        `Version ${input.version} of role "${role.name}" carries no promotion evidence, so it cannot be restored.`,
        { roleId: role.id, version: input.version },
      );
    }

    const moved = await this.deps.roles.setVersionStatus({
      roleId: role.id,
      version: input.version,
      expectedStatus: "disabled",
      nextStatus: "promoted",
      at: this.deps.clock.nowIso(),
    });
    if (!moved) {
      throw new DeniedError(
        "record.unavailable",
        `Version ${input.version} of role "${role.name}" could not be restored: another version has been promoted since it was disabled. Roll forward or revert deliberately instead.`,
        { roleId: role.id, version: input.version },
      );
    }

    const released = await this.deps.containment.release(
      "role",
      role.id,
      input.actor.actorId,
      input.reason,
    );

    await this.deps.audit.record(
      auditDecision({
        eventType: "role.promoted",
        actorId: input.actor.actorId,
        actorKind: input.actor.kind,
        actorRoles: input.actor.roles,
        subject: {
          roleId: role.id,
          roleName: role.name,
          roleVersion: String(input.version),
          evaluationRunId: version.evidence.evaluationRunId,
        },
        inputDigests: { definition: version.definitionDigest },
        decision: {
          restoredFromDisabled: true,
          reason: input.reason.slice(0, 512),
          approvalId: version.evidence.approvalId,
          accuracy: version.evidence.accuracy,
        },
      }),
    );

    return { switch: released, version: moved.version };
  }

  /**
   * The version of this role that may act.
   *
   * @throws {DeniedError} `role.not_promoted` when nothing is promoted, or
   *   when a specific version was named and it is not the promoted one.
   */
  async requireActable(roleId: Id<"role">, version?: number): Promise<RoleVersion> {
    const promoted = await this.deps.roles.promotedVersion(roleId);
    if (!promoted) {
      throw new DeniedError(
        "role.not_promoted",
        `Role ${roleId} has no promoted version, so it cannot act. A role acts only after it has been evaluated and a person with authority has approved it.`,
        { roleId },
      );
    }
    if (version !== undefined && promoted.version !== version) {
      throw new DeniedError(
        "role.not_promoted",
        `Version ${version} of role ${roleId} is not the promoted version (v${promoted.version} is), so it cannot act.`,
        { roleId, version, promotedVersion: promoted.version },
      );
    }
    return promoted;
  }

  /**
   * Authorise an action taken *by a role*.
   *
   * The role's declared bounds are applied first, then the general chokepoint
   * runs. The order matters: these checks are free, and the chokepoint's last
   * step consumes an approval, which is not. A role that was never going to be
   * allowed should not burn a human's decision discovering that.
   *
   * **Every action a role takes has to come through here.** Calling
   * `Authorizer.authorize` directly with a `roleId` still applies containment,
   * the operating mode, the actor's own roles, the ceilings, and the approval
   * — but not the role's declared action list, risk ceiling, or data scopes,
   * because those live in this module and the chokepoint below cannot see
   * them. The workflow engine is the caller that must route through this
   * method; that is stated here rather than assumed, and it is the one part of
   * this module's guarantee that is a wiring obligation rather than a
   * structural property.
   *
   * @throws {DeniedError} `role.not_promoted`, `role.ceiling_exceeded`,
   *   `authorization.action_not_permitted`, `authorization.data_scope_violation`,
   *   or anything the chokepoint raises.
   */
  async authorizeRoleAction(request: RoleActionRequest): Promise<AuthorizationGrant> {
    const version = await this.requireActable(request.roleId);
    const definition = version.definition;

    // The action's tier against the role's ceiling, before membership. A role
    // asked to do something above its ceiling gets `role.ceiling_exceeded`
    // whether or not the action happens to be on its list, because "you are
    // over your ceiling" is the more useful and more serious diagnosis.
    const descriptor = this.deps.actions.require(request.action);
    if (RISK_RANK[descriptor.risk] > RISK_RANK[definition.riskCeiling]) {
      throw new DeniedError(
        "role.ceiling_exceeded",
        `Role "${definition.name}" declares a risk ceiling of "${definition.riskCeiling}" and was asked to perform "${request.action}", which is ${descriptor.risk}. Raising the ceiling is a new version with its own evidence and approval.`,
        {
          roleId: request.roleId,
          action: request.action,
          risk: descriptor.risk,
          ceiling: definition.riskCeiling,
        },
      );
    }

    if (!definition.actions.includes(request.action)) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `Role "${definition.name}" v${version.version} does not declare the action "${request.action}". Its declared actions are: ${definition.actions.join(", ")}.`,
        { roleId: request.roleId, action: request.action },
      );
    }

    if (!definition.operatingModes.includes(request.mode)) {
      throw new DeniedError(
        "authorization.action_not_permitted",
        `Role "${definition.name}" v${version.version} may run in ${definition.operatingModes.join(", ")} mode, not ${request.mode}.`,
        { roleId: request.roleId, action: request.action, mode: request.mode },
      );
    }

    const requiredScopes = request.requiredScopes ?? [];
    const undeclared = requiredScopes.filter((scope) => !definition.dataScopes.includes(scope));
    if (undeclared.length > 0) {
      throw new DeniedError(
        "authorization.data_scope_violation",
        `Role "${definition.name}" v${version.version} is not scoped to ${undeclared.join(", ")}. Its declared data scopes are: ${definition.dataScopes.join(", ") || "none"}.`,
        { roleId: request.roleId, action: request.action, missing: undeclared.join(",") },
      );
    }

    // `roleId` is set here — this *is* the role acting, so the per-role
    // containment switch applies and an operator's stop button reaches it.
    return this.deps.authorizer.authorize({ ...request, roleId: request.roleId });
  }

  /** @throws {DeniedError} `record.unavailable` when there is no such evidence. */
  private async requireEvidence(
    role: Role,
    version: RoleVersion,
    evaluationRunId: Id<"evaluation">,
  ): Promise<EvaluationRun> {
    const evidence = await this.deps.evaluations.getEvaluation(evaluationRunId);
    if (!evidence) {
      throw new DeniedError(
        "record.unavailable",
        `Promotion of role "${role.name}" v${version.version} cites evaluation run ${evaluationRunId}, which is not in the record. A promotion without evidence is a claim, and this platform does not promote on claims.`,
        { roleId: role.id, version: version.version, evaluationRunId },
      );
    }
    return evidence;
  }

  /**
   * Refuse evidence that describes something other than what will run.
   *
   * `approval.digest_mismatch` is the reason on every branch, and deliberately:
   * this is the same failure the approval digest exists to catch — what was
   * shown is not what is about to happen — one step earlier in the chain.
   */
  private assertEvidenceDescribesWhatWillRun(
    role: Role,
    version: RoleVersion,
    evidence: EvaluationRun,
  ): void {
    const definition = version.definition;

    if (evidence.roleId !== role.id || evidence.roleVersion !== version.version) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Evaluation run ${evidence.id} measured role ${evidence.roleId} v${evidence.roleVersion}, not "${role.name}" v${version.version}.`,
        { roleId: role.id, version: version.version, evaluationRunId: evidence.id },
      );
    }

    if (evidence.definitionDigest !== version.definitionDigest) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Evaluation run ${evidence.id} measured a different definition of "${role.name}" v${version.version}. What was evaluated is not what is about to be promoted.`,
        { roleId: role.id, version: version.version, evaluationRunId: evidence.id },
      );
    }

    if (evidence.goldenSetId !== definition.evaluationSetId) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Role "${role.name}" v${version.version} declares golden set "${definition.evaluationSetId}" but cites evidence measured against "${evidence.goldenSetId}". Measuring against one set and promoting against another is how a weak result gets laundered.`,
        {
          roleId: role.id,
          declared: definition.evaluationSetId,
          measured: evidence.goldenSetId,
        },
      );
    }

    // Drift. The inventory and the template registry are read *now*, so
    // evidence produced before a model or prompt change is refused rather than
    // silently vouching for a system that no longer exists.
    const entry = this.deps.inventory.resolve(definition.modelTask);
    if (entry.modelId !== evidence.modelId || entry.modelVersion !== evidence.modelVersion) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Task "${definition.modelTask}" now resolves to ${entry.modelId} (${entry.modelVersion}); the evidence was measured on ${evidence.modelId} (${evidence.modelVersion}). Re-evaluate against the model that will actually run.`,
        { roleId: role.id, task: definition.modelTask, evaluationRunId: evidence.id },
      );
    }
    if (entry.promptTemplateId !== definition.promptTemplateId) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Role "${role.name}" declares prompt "${definition.promptTemplateId}" but task "${definition.modelTask}" is bound to "${entry.promptTemplateId}" in the model inventory.`,
        { roleId: role.id, task: definition.modelTask },
      );
    }

    const template = this.deps.templates.require(
      definition.promptTemplateId,
      definition.promptTemplateVersion,
    );
    if (
      template.id !== evidence.promptTemplateId ||
      template.version !== evidence.promptTemplateVersion
    ) {
      throw new DeniedError(
        "approval.digest_mismatch",
        `Role "${role.name}" v${version.version} runs prompt ${template.id} v${template.version}; the evidence was measured on ${evidence.promptTemplateId} v${evidence.promptTemplateVersion}.`,
        { roleId: role.id, evaluationRunId: evidence.id },
      );
    }
  }
}

function toProposal(version: RoleVersion, evidence: EvaluationRun): PromotionProposal {
  return {
    roleId: version.roleId,
    version: version.version,
    definitionDigest: version.definitionDigest,
    evaluationRunId: evidence.id,
    goldenSetDigest: evidence.goldenSetDigest,
    accuracy: evidence.accuracy,
    threshold: evidence.threshold,
    modelId: evidence.modelId,
    modelVersion: evidence.modelVersion,
    promptTemplateId: evidence.promptTemplateId,
    promptTemplateVersion: evidence.promptTemplateVersion,
  };
}
