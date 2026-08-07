import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { ApprovalService } from "./approvals.js";
import type { CeilingEnforcer } from "./ceilings.js";
import type { ContainmentController } from "./containment.js";
import type { ActionRegistry } from "./registry.js";
import type { ActionRequest, AuthorizationGrant } from "./types.js";

/**
 * The authorization chokepoint.
 *
 * One function that every action passes through. Not one per module, not a
 * decorator someone can forget to apply — one place, so that "is this
 * permitted?" has exactly one answer and exactly one audit trail.
 *
 * The checks run in a deliberate order, cheapest and most decisive first:
 *
 *   1. Registration      An unregistered action is refused. No default tier.
 *   2. Prohibited tier   Refused unconditionally, whatever else is true.
 *   3. Containment       The stop button beats everything below it.
 *   4. Operating mode    Shadow mode must not produce effects.
 *   5. Role              Does this actor hold a role allowed to do this?
 *   6. Data scope        Is the actor entitled to this data?
 *   7. Step-up           Recent re-authentication for high-consequence work.
 *   8. Ceilings          Spend, rate, and time, with the estimate reserved.
 *   9. Approval          Consumed atomically and bound to the proposal digest.
 *
 * Approval is last because consuming an approval is destructive: approvals are
 * single-use, so spending one and then failing a cheaper check would burn a
 * human's decision and force them to approve again. Everything that can refuse
 * for free refuses before anything is spent.
 *
 * Every outcome — grant or denial — is written to the audit log before this
 * returns. If the audit write fails, the whole authorization fails: an action
 * the platform cannot account for does not happen.
 */
export class Authorizer {
  constructor(
    private readonly registry: ActionRegistry,
    private readonly containment: ContainmentController,
    private readonly ceilings: CeilingEnforcer,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    private readonly stepUpMaxAgeSeconds: number,
  ) {}

  /**
   * Authorise one action.
   *
   * @throws {DeniedError} on any refusal. The caller must not perform the
   *   effect unless this resolves.
   */
  async authorize(request: ActionRequest): Promise<AuthorizationGrant> {
    let reservedEstimate = 0;

    try {
      // 1. Registration. An action nobody classified cannot be performed.
      const descriptor = this.registry.require(request.action);

      // 2. Prohibited actions are refused before anything else is considered.
      if (descriptor.risk === "prohibited") {
        throw new DeniedError(
          "authorization.action_not_permitted",
          `Action "${request.action}" is prohibited by this platform and cannot be enabled by configuration.`,
          { action: request.action },
        );
      }

      // 3. Containment. Checked here so an in-flight run cannot outrun a pause.
      await this.containment.assertClear({
        workflowName: request.workflowName,
        roleId: request.roleId,
        integration: descriptor.integration,
      });

      // 4. Operating mode. Shadow mode is a real mode, not a label: an action
      //    with an external effect is simply not permitted in it.
      if (!descriptor.allowedModes.includes(request.mode)) {
        throw new DeniedError(
          "authorization.action_not_permitted",
          `Action "${request.action}" may not be performed in ${request.mode} mode. Permitted modes: ${descriptor.allowedModes.join(", ") || "none"}.`,
          { action: request.action, mode: request.mode },
        );
      }

      // 5. Human-only actions are never performed by the platform. The system
      //    gathers evidence; the person acts.
      if (descriptor.humanInvolvement === "human_only") {
        throw new DeniedError(
          "authorization.action_not_permitted",
          `Action "${request.action}" is human-only. The platform may prepare it but must not perform it.`,
          { action: request.action },
        );
      }

      // 6. Role. A service actor is checked against the same list, so a machine
      //    caller cannot do more than the role it was issued.
      if (descriptor.allowedRoles.length === 0) {
        throw new DeniedError(
          "authorization.action_not_permitted",
          `Action "${request.action}" has no permitted roles.`,
          { action: request.action },
        );
      }
      const holdsRole =
        request.actor.kind === "system"
          ? descriptor.allowedRoles.includes("system")
          : request.actor.roles.some((role) => descriptor.allowedRoles.includes(role));
      if (!holdsRole) {
        throw new DeniedError(
          "authorization.action_not_permitted",
          `${request.actor.actorId} holds none of the roles permitted to perform "${request.action}" (${descriptor.allowedRoles.join(", ")}).`,
          { action: request.action, actorId: request.actor.actorId },
        );
      }

      // 7. Data scope. Declared per request; the actor's entitlements are
      //    expressed as roles prefixed `scope:`.
      if (request.requiredScopes && request.requiredScopes.length > 0) {
        const held = new Set(
          request.actor.roles
            .filter((role) => role.startsWith("scope:"))
            .map((role) => role.slice("scope:".length)),
        );
        const missing = request.requiredScopes.filter((scope) => !held.has(scope));
        if (missing.length > 0) {
          throw new DeniedError(
            "authorization.data_scope_violation",
            `${request.actor.actorId} is not entitled to data scope(s): ${missing.join(", ")}.`,
            { action: request.action, actorId: request.actor.actorId, missing: missing.join(",") },
          );
        }
      }

      // 8. Step-up re-authentication.
      if (descriptor.requiresStepUp && request.actor.kind === "human") {
        const age = request.secondsSinceAuthentication;
        if (age === undefined || age > this.stepUpMaxAgeSeconds) {
          throw new DeniedError(
            "authorization.step_up_required",
            `"${request.action}" requires re-authentication within the last ${this.stepUpMaxAgeSeconds}s.`,
            { action: request.action, actorId: request.actor.actorId },
          );
        }
      }

      // 9. Ceilings, enforced at consumption as well as here. The estimate is
      //    reserved so two concurrent actions cannot both pass against the
      //    same headroom.
      if (request.runId) {
        await this.ceilings.check(request.runId, {
          estimatedCostUsd: request.estimatedCostUsd ?? 0,
          isModelCall: false,
        });
        reservedEstimate = request.estimatedCostUsd ?? 0;
      }

      // 10. Approval, last because consuming one is destructive.
      let consumedApprovalId: ActionRequest["approvalId"];
      if (descriptor.humanInvolvement === "proposed_then_approved") {
        if (!request.proposalDigest) {
          throw new DeniedError(
            "approval.digest_mismatch",
            `"${request.action}" requires approval, so the caller must supply a digest of exactly what it proposes to do.`,
            { action: request.action },
          );
        }
        if (!request.approvalId) {
          throw new DeniedError(
            "approval.required",
            `"${request.action}" requires ${descriptor.approvalsRequired} human approval(s) before it can proceed.`,
            { action: request.action, approvalsRequired: descriptor.approvalsRequired },
          );
        }
        const consumed = await this.approvals.consume({
          approvalId: request.approvalId,
          expectedProposalDigest: request.proposalDigest,
          runId: request.runId,
          actor: request.actor,
          // The approval must have been raised for this action, not merely for
          // some action. Passed in so the check runs *before* the consumption:
          // refusing after it would burn the approver's decision on a request
          // that was never going to be permitted, which is the thing the
          // ordering at the top of this file exists to avoid.
          expectedAction: request.action,
        });
        // Defence in depth for a caller that supplied no expected action. Not
        // reachable from here, and deliberately kept: the invariant belongs to
        // the chokepoint, not to one argument being remembered.
        if (consumed.action !== request.action) {
          throw new DeniedError(
            "approval.digest_mismatch",
            `Approval ${consumed.id} was raised for "${consumed.action}", not "${request.action}".`,
            { action: request.action, approvalId: consumed.id },
          );
        }
        consumedApprovalId = consumed.id;
      }

      const grant: AuthorizationGrant = {
        action: request.action,
        descriptor,
        consumedApprovalId,
        grantedAt: this.clock.nowIso(),
      };

      await this.audit.record(
        auditDecision({
          eventType: "authorization.granted",
          actorId: request.actor.actorId,
          actorKind: request.actor.kind,
          actorRoles: request.actor.roles,
          runId: request.runId,
          correlationId: request.correlationId,
          subject: { ...(request.subject ?? {}), action: request.action },
          inputDigests: request.proposalDigest ? { proposal: request.proposalDigest } : {},
          decision: {
            risk: descriptor.risk,
            mode: request.mode,
            humanInvolvement: descriptor.humanInvolvement,
            reversible: descriptor.reversible,
            ...(consumedApprovalId ? { approvalId: consumedApprovalId } : {}),
          },
        }),
      );

      return grant;
    } catch (error) {
      // Release any reservation taken before the failure, so a denial does not
      // permanently shrink the run's remaining budget.
      if (reservedEstimate > 0 && request.runId) {
        this.ceilings.release(request.runId, reservedEstimate);
      }

      const denied =
        error instanceof DeniedError
          ? error
          : new DeniedError(
              "authorization.action_not_permitted",
              `Authorization failed for "${request.action}": ${error instanceof Error ? error.message : String(error)}`,
              { action: request.action },
            );

      // Record the denial. If this write itself fails the original denial still
      // propagates — we never convert a refusal into a success.
      try {
        await this.audit.record(
          auditDecision({
            eventType: "authorization.denied",
            actorId: request.actor.actorId,
            actorKind: request.actor.kind,
            actorRoles: request.actor.roles,
            runId: request.runId,
            correlationId: request.correlationId,
            subject: { ...(request.subject ?? {}), action: request.action },
            inputDigests: request.proposalDigest ? { proposal: request.proposalDigest } : {},
            decision: { reason: denied.reason, mode: request.mode },
          }),
        );
      } catch {
        // Deliberately swallowed: the denial below is the important outcome and
        // must not be replaced by an audit-write error.
      }

      throw denied;
    }
  }

  /**
   * Would this action be permitted, without performing or consuming anything?
   *
   * Used by the console to decide whether to offer a control. Deliberately
   * does not consume approvals or reserve budget, and therefore does not
   * prove the action would succeed — only that it would not fail for a
   * static reason.
   */
  async preview(request: ActionRequest): Promise<{ permitted: boolean; reason?: string }> {
    try {
      const descriptor = this.registry.require(request.action);
      if (descriptor.risk === "prohibited") return { permitted: false, reason: "prohibited" };
      await this.containment.assertClear({
        workflowName: request.workflowName,
        roleId: request.roleId,
        integration: descriptor.integration,
      });
      if (!descriptor.allowedModes.includes(request.mode)) {
        return { permitted: false, reason: `not permitted in ${request.mode} mode` };
      }
      if (descriptor.humanInvolvement === "human_only") {
        return { permitted: false, reason: "human-only action" };
      }
      const holdsRole =
        request.actor.kind === "system"
          ? descriptor.allowedRoles.includes("system")
          : request.actor.roles.some((role) => descriptor.allowedRoles.includes(role));
      if (!holdsRole) return { permitted: false, reason: "actor does not hold a permitted role" };
      return { permitted: true };
    } catch (error) {
      // allow-swallow: preview reports, it never acts. Converting a denial into
      // `permitted: false` is this method's entire purpose, and an unknown
      // failure becomes "unavailable" — which the console renders as a
      // disabled control. Both outcomes are refusals, so nothing fails open.
      return {
        permitted: false,
        reason: error instanceof DeniedError ? error.reason : "unavailable",
      };
    }
  }
}
