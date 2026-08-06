import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import { digestValue } from "../kernel/hash.js";
import type { Id } from "../kernel/ids.js";
import type { AuditLog } from "../audit/log.js";
import { decision as auditDecision } from "../audit/log.js";
import type { ApprovalService } from "../guard/approvals.js";
import { screen } from "../guard/screen.js";
import type { RiskTier } from "../guard/types.js";
import type { EnrollmentStore, SpendStore } from "./port.js";
import type { RateLimiterLike } from "./ratelimit-port.js";
import type {
  AdmissionDecision,
  AdmissionRequest,
  DenialClass,
  EnrolledAgent,
  ExternalAgentId,
} from "./types.js";

/**
 * The admission chain.
 *
 * One function that answers "may this external agent do this?", and the only
 * answer to that question anywhere. Every inbound operation runs it — screening
 * a proposed action, reporting a finished one, starting a run, executing
 * through a governed integration, and committing a previously approved write.
 *
 * The order below is deliberate, cheapest and most decisive first:
 *
 *   1. Enrolled?          An unenrolled caller is refused. No anonymous access.
 *   2. Revoked?           Terminal, and takes effect immediately.
 *   3. Contained?         Reversible, and takes effect immediately.
 *   4. Expired?           Enrollment expiry is data, checked here, not a job.
 *   5. Tool permitted?    Against the enrolled grant list.
 *   6. Risk ceiling       With the OPERATOR'S rating flooring what the agent
 *                         declared. External tool names are arbitrary strings;
 *                         the registry decides how risky a tool is.
 *   7. Data scope         The scopes this operation needs, against the grant.
 *   8. Budget             Against the ceiling for the current period.
 *   9. Input              Bounded FIRST, then screened. An unbounded field lets
 *                         an attacker pad the payload past a scan window.
 *  10. Approval floor     Above the threshold, park a real, labelled approval.
 *
 * Approval is last for the same reason it is last in the native chokepoint:
 * everything that can refuse for free refuses before a human's attention is
 * spent.
 *
 * **The chain is re-run at commit time.** A human's approval is necessary, not
 * sufficient: if an operator revokes the agent or disables a connector while an
 * approval sits in the queue, the commit must still be refused.
 */

const RISK_ORDER: Record<RiskTier, number> = {
  routine: 0,
  sensitive: 1,
  high_consequence: 2,
  prohibited: 3,
};

/** The higher of two tiers. Used to apply the operator's floor. */
export function maxRisk(left: RiskTier, right: RiskTier): RiskTier {
  return RISK_ORDER[left] >= RISK_ORDER[right] ? left : right;
}

export function riskAtLeast(tier: RiskTier, floor: RiskTier): boolean {
  return RISK_ORDER[tier] >= RISK_ORDER[floor];
}

/** True when `tier` is strictly above `ceiling`. */
export function riskExceeds(tier: RiskTier, ceiling: RiskTier): boolean {
  return RISK_ORDER[tier] > RISK_ORDER[ceiling];
}

/** Bounds applied before anything is screened or stored. */
export const INPUT_BOUNDS = {
  tool: 128,
  untrustedInput: 20_000,
  subjectKeys: 16,
  subjectValue: 256,
  scopes: 16,
} as const;

export interface AdmissionOptions {
  /** Tier at or above which a human must approve before the agent proceeds. */
  readonly approvalThreshold?: RiskTier;
  /** How long a parked approval stays open. */
  readonly approvalTtlMs?: number;
  /** Roles eligible to approve external-agent actions. */
  readonly approverRoles?: readonly string[];
}

export interface AdmissionContext {
  /** Set when the caller is committing a previously approved action. */
  readonly isCommit?: boolean;
  /** Digest binding an approval to exactly what was proposed. */
  readonly proposalDigest?: string;
  /**
   * Report that approval is needed without raising it here.
   *
   * The governed-execution path has to create its parked record *before* the
   * approval, so that a failure to raise the approval can hand the slot back
   * rather than stranding a pending record with nothing to consume. If this
   * chain raised the approval first, that ordering would invert and a failure
   * would strand a granted approval nothing could spend instead.
   */
  readonly deferApproval?: boolean;
}

export class AdmissionService {
  private readonly approvalThreshold: RiskTier;
  private readonly approvalTtlMs: number;
  private readonly approverRoles: readonly string[];

  constructor(
    private readonly enrollment: EnrollmentStore,
    private readonly spend: SpendStore,
    private readonly rateLimiter: RateLimiterLike,
    private readonly approvals: ApprovalService,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    options: AdmissionOptions = {},
  ) {
    this.approvalThreshold = options.approvalThreshold ?? "high_consequence";
    this.approvalTtlMs = options.approvalTtlMs ?? 24 * 60 * 60 * 1000;
    this.approverRoles = options.approverRoles ?? ["supervisor", "compliance_reviewer"];
  }

  /**
   * Run the chain.
   *
   * Returns a decision rather than throwing on refusal, because the caller has
   * to record the denial against the agent's misbehaviour counter and return a
   * structured answer to it. Infrastructure failures still throw: they are not
   * the agent's fault and must not count against it.
   */
  async admit(
    request: AdmissionRequest,
    context: AdmissionContext = {},
  ): Promise<AdmissionDecision> {
    const now = this.clock.nowIso();

    // Bound the input before touching any of it. Doing this first means a
    // padded field cannot push the part we screen outside the window we scan.
    const boundsFailure = boundsCheck(request);
    if (boundsFailure) {
      return this.deny(request, "misbehaviour", "authorization.action_not_permitted", boundsFailure);
    }

    // Rate limit before the expensive checks, and before any store read that a
    // flood could turn into a denial of service against the rest of the plane.
    const withinRate = await this.rateLimiter.check(request.agentId, request.operation);
    if (!withinRate.allowed) {
      return this.deny(
        request,
        "misbehaviour",
        "ceiling.rate_exceeded",
        `Rate ceiling reached for ${request.operation}: ${withinRate.count} requests in the window.`,
      );
    }

    const agent = await this.enrollment.getAgent(request.agentId);
    if (!agent) {
      // Not counted as agent misbehaviour: an unenrolled id has no meter to
      // count against, and containing something that does not exist is
      // meaningless.
      return this.deny(
        request,
        "infrastructure",
        "authorization.action_not_permitted",
        "This agent is not enrolled. There is no anonymous access to this platform.",
      );
    }

    if (agent.status === "revoked") {
      return this.deny(
        request,
        "misbehaviour",
        "containment.role_disabled",
        `Enrollment for ${agent.name} has been revoked${agent.statusReason ? `: ${agent.statusReason}` : "."}`,
        agent,
      );
    }

    if (agent.status === "contained") {
      return this.deny(
        request,
        "misbehaviour",
        "containment.role_disabled",
        `${agent.name} is contained and must be released by an operator${agent.statusReason ? `: ${agent.statusReason}` : "."}`,
        agent,
      );
    }

    if (now > agent.expiresAt) {
      return this.deny(
        request,
        "misbehaviour",
        "authorization.action_not_permitted",
        `Enrollment for ${agent.name} expired at ${agent.expiresAt}.`,
        agent,
      );
    }

    // The tool, and the operator's rating for it.
    const grant = agent.allowedTools.find((entry) => entry.tool === request.tool);
    if (!grant) {
      return this.deny(
        request,
        "misbehaviour",
        "authorization.action_not_permitted",
        `${agent.name} is not permitted to use "${request.tool}".`,
        agent,
      );
    }

    // The operator's rating FLOORS the agent's declaration. An agent calling
    // `issue_refund` may declare it routine, through carelessness or otherwise;
    // the registry decides how risky a tool is, not the caller's honesty.
    const effectiveRisk = grant.operatorRisk
      ? maxRisk(request.declaredRisk, grant.operatorRisk)
      : request.declaredRisk;

    if (effectiveRisk === "prohibited") {
      return this.deny(
        request,
        "misbehaviour",
        "authorization.action_not_permitted",
        `"${request.tool}" is rated prohibited and cannot be performed.`,
        agent,
        effectiveRisk,
      );
    }

    if (riskExceeds(effectiveRisk, agent.riskCeiling)) {
      return this.deny(
        request,
        "misbehaviour",
        "role.ceiling_exceeded",
        `"${request.tool}" is ${effectiveRisk}${grant.operatorRisk && grant.operatorRisk !== request.declaredRisk ? ` (raised from the declared ${request.declaredRisk} by the operator's rating)` : ""}, above ${agent.name}'s ceiling of ${agent.riskCeiling}.`,
        agent,
        effectiveRisk,
      );
    }

    // Data scope.
    if (request.requiredScopes && request.requiredScopes.length > 0) {
      const held = new Set(agent.dataScopes);
      const missing = request.requiredScopes.filter((scope) => !held.has(scope));
      if (missing.length > 0) {
        return this.deny(
          request,
          "misbehaviour",
          "authorization.data_scope_violation",
          `${agent.name} is not entitled to data scope(s): ${missing.join(", ")}.`,
          agent,
          effectiveRisk,
        );
      }
    }

    // Budget for the current period.
    const periodKey = budgetPeriodKey(agent, now);
    const meter = await this.spend.getMeter(agent.id, periodKey);
    const spent = meter?.spentUsd ?? 0;
    const estimate = request.estimatedCostUsd ?? 0;
    const remaining = Math.max(0, agent.spendCeilingUsd - spent);

    if (spent >= agent.spendCeilingUsd) {
      return this.deny(
        request,
        "misbehaviour",
        "ceiling.spend_exceeded",
        `${agent.name} has spent $${spent.toFixed(2)} of its $${agent.spendCeilingUsd.toFixed(2)} ${agent.budgetPeriod} ceiling.`,
        agent,
        effectiveRisk,
        remaining,
      );
    }
    if (spent + estimate > agent.spendCeilingUsd) {
      return this.deny(
        request,
        "misbehaviour",
        "ceiling.spend_exceeded",
        `This would take ${agent.name} to $${(spent + estimate).toFixed(2)}, past its $${agent.spendCeilingUsd.toFixed(2)} ${agent.budgetPeriod} ceiling.`,
        agent,
        effectiveRisk,
        remaining,
      );
    }

    // Untrusted input: bounded above, screened here. A screen that errors
    // denies — it has not answered "clean".
    if (request.untrustedInput) {
      try {
        screen(request.untrustedInput);
      } catch (error) {
        const reason =
          error instanceof DeniedError ? error.reason : "screen.unavailable";
        return this.deny(
          request,
          reason === "screen.unavailable" ? "infrastructure" : "misbehaviour",
          reason,
          error instanceof DeniedError
            ? error.message
            : "The accompanying text could not be screened, so the request was refused.",
          agent,
          effectiveRisk,
          remaining,
        );
      }
    }

    await this.enrollment.touchLastSeen(agent.id, now);

    // The approval floor.
    if (riskAtLeast(effectiveRisk, this.approvalThreshold) && !context.isCommit) {
      if (context.deferApproval) {
        return {
          outcome: "approval_required",
          effectiveRisk,
          remainingBudgetUsd: remaining,
          message: "This action needs a human decision.",
        };
      }
      const approvalId = await this.parkApproval(agent, request, effectiveRisk, context);
      return {
        outcome: "approval_required",
        effectiveRisk,
        approvalId,
        remainingBudgetUsd: remaining,
        message: `This action needs a human decision. Poll approval ${approvalId}.`,
      };
    }

    await this.audit.record(
      auditDecision({
        eventType: "authorization.granted",
        actorId: agent.id,
        // Marked external so spend, oversight, and reporting can tell this
        // apart from native work without a parallel system.
        actorKind: "service",
        actorRoles: ["external_agent"],
        correlationId: request.correlationId,
        subject: {
          ...boundedSubject(request.subject),
          externalAgentId: agent.id,
          agentName: agent.name,
          tool: request.tool,
          operation: request.operation,
        },
        decision: {
          effectiveRisk,
          declaredRisk: request.declaredRisk,
          operatorFloored: effectiveRisk !== request.declaredRisk,
          hostPlatform: agent.hostPlatform,
          external: true,
        },
      }),
    );

    return { outcome: "allowed", effectiveRisk, remainingBudgetUsd: remaining };
  }

  /**
   * Park a real approval, labelled as raised by an external agent.
   *
   * The label matters: an approver seeing "issue a refund" needs to know it was
   * asked for by a vendor's agent running in the CRM, not by a colleague. It
   * changes what they check before saying yes.
   */
  private async parkApproval(
    agent: EnrolledAgent,
    request: AdmissionRequest,
    effectiveRisk: RiskTier,
    context: AdmissionContext,
  ): Promise<Id<"approval">> {
    const proposalDigest =
      context.proposalDigest ??
      digestValue({
        agentId: agent.id,
        tool: request.tool,
        operation: request.operation,
        subject: request.subject ?? {},
      });

    const parked = await this.approvals.request({
      action: `external.${request.operation}`,
      proposalDigest,
      summary: `[external agent] ${agent.name} on ${agent.hostPlatform} requests "${request.tool}" — ${agent.purpose}`,
      requestedBy: {
        actorId: agent.id,
        kind: "service",
        roles: ["external_agent"],
      },
      approvalsRequired: 1,
      eligibleRoles: this.approverRoles,
      correlationId: request.correlationId,
      subject: {
        ...boundedSubject(request.subject),
        externalAgentId: agent.id,
        agentName: agent.name,
        hostPlatform: agent.hostPlatform,
        owner: agent.owner,
        department: agent.department,
        tool: request.tool,
        effectiveRisk,
      },
      ttlMs: this.approvalTtlMs,
    });

    return parked.id;
  }

  private async deny(
    request: AdmissionRequest,
    denialClass: DenialClass,
    reason: string,
    message: string,
    agent?: EnrolledAgent,
    effectiveRisk: RiskTier = request.declaredRisk,
    remaining = 0,
  ): Promise<AdmissionDecision> {
    // Only misbehaviour counts toward automatic containment. Containing a team
    // because our own database blipped punishes them for our outage and teaches
    // them the platform is unreliable rather than strict.
    if (denialClass === "misbehaviour") {
      await this.rateLimiter.recordDenial(request.agentId, denialClass);
    }

    try {
      await this.audit.record(
        auditDecision({
          eventType: "authorization.denied",
          actorId: request.agentId,
          actorKind: "service",
          actorRoles: ["external_agent"],
          correlationId: request.correlationId,
          subject: {
            ...boundedSubject(request.subject),
            externalAgentId: request.agentId,
            tool: request.tool.slice(0, INPUT_BOUNDS.tool),
            operation: request.operation,
            ...(agent ? { agentName: agent.name } : {}),
          },
          decision: {
            reason,
            denialClass,
            effectiveRisk,
            declaredRisk: request.declaredRisk,
            external: true,
          },
        }),
      );
    } catch {
      // allow-swallow: the denial below is the outcome that matters and must
      // not be replaced by an audit-write failure. The failure is itself
      // recorded by the audit log's own error path.
    }

    return { outcome: "denied", effectiveRisk, reason, message, remainingBudgetUsd: remaining };
  }
}

/** `lifetime`, or `YYYY-MM` for a monthly budget. */
export function budgetPeriodKey(agent: EnrolledAgent, nowIso: string): string {
  if (agent.budgetPeriod === "lifetime") return "lifetime";
  return nowIso.slice(0, 7);
}

/**
 * Bound every field before anything reads or screens it.
 *
 * Returns an operator-readable failure, or null when the shape is acceptable.
 */
function boundsCheck(request: AdmissionRequest): string | null {
  if (typeof request.tool !== "string" || request.tool.length === 0) {
    return "No tool was named.";
  }
  if (request.tool.length > INPUT_BOUNDS.tool) {
    return `Tool name is ${request.tool.length} characters, past the ${INPUT_BOUNDS.tool} limit.`;
  }
  if (
    request.untrustedInput !== undefined &&
    request.untrustedInput.length > INPUT_BOUNDS.untrustedInput
  ) {
    return `Accompanying text is ${request.untrustedInput.length} characters, past the ${INPUT_BOUNDS.untrustedInput} limit. Oversized input is refused rather than truncated, because truncating would screen only part of what would be acted on.`;
  }
  if (request.subject) {
    const keys = Object.keys(request.subject);
    if (keys.length > INPUT_BOUNDS.subjectKeys) {
      return `Subject has ${keys.length} keys, past the ${INPUT_BOUNDS.subjectKeys} limit.`;
    }
    for (const [key, value] of Object.entries(request.subject)) {
      if (typeof value !== "string" || value.length > INPUT_BOUNDS.subjectValue) {
        return `Subject value "${key}" is not a string within ${INPUT_BOUNDS.subjectValue} characters.`;
      }
    }
  }
  if (request.requiredScopes && request.requiredScopes.length > INPUT_BOUNDS.scopes) {
    return `Too many data scopes requested.`;
  }
  if (request.estimatedCostUsd !== undefined) {
    if (!Number.isFinite(request.estimatedCostUsd) || request.estimatedCostUsd < 0) {
      return "Estimated cost must be a finite, non-negative number.";
    }
  }
  return null;
}

function boundedSubject(
  subject: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!subject) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(subject).slice(0, INPUT_BOUNDS.subjectKeys)) {
    if (typeof value === "string") out[key] = value.slice(0, INPUT_BOUNDS.subjectValue);
  }
  return out;
}
