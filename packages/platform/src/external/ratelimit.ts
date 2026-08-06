import { decision } from "../audit/log.js";
import type { AuditLog } from "../audit/log.js";
import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import type { EnrollmentStore, RateLimitStore } from "./port.js";
import type { DenialClass, ExternalAgentId, RateLimitPolicy } from "./types.js";

/**
 * Per-agent request limits, and what repeated refusal means.
 *
 * Two jobs, and the second is the interesting one.
 *
 * The first is an ordinary rolling-window limit, per agent and per operation.
 * Per operation rather than per agent alone, because an agent hammering
 * `run.heartbeat` should not exhaust the budget that its `execute.commit` calls
 * need — one noisy loop would otherwise lock the agent out of the operation
 * that actually matters.
 *
 * The second is the response to persistent refusal. An external agent runs
 * somewhere we cannot reach: we cannot kill its process, throttle its host, or
 * take its network away. An agent that keeps asking for things it is not
 * allowed is either broken or hostile, and in both cases the only lever this
 * platform holds is to stop answering — so a run of denials inside the window
 * contains the agent, and a human has to release it.
 *
 * **Which denials count.** Only misbehaviour. If our database is unreachable,
 * or the audit chain will not accept a write, this platform refuses — correctly
 * — and the agent sees a denial it did nothing to earn. Counting those would
 * contain a well-behaved team because we had an outage, page their owner at
 * midnight over our fault, and teach them that the governance plane is
 * unreliable rather than strict. `DenialClass` carries the distinction and this
 * class honours it by never writing an infrastructure denial into the ledger at
 * all: the ledger's only consumer is the containment threshold, so a row that
 * must not contribute to it does not belong in it. Infrastructure failures are
 * recorded where an outage belongs — in the audit chain, by the caller that
 * refused, and in the operating record.
 */

/**
 * The request window.
 *
 * The policy states a per-minute figure, so the window is a minute by
 * definition. It is rolling rather than a fixed bucket: with fixed buckets an
 * agent can send a full allowance in the last second of one bucket and another
 * full allowance in the first second of the next, which is twice the limit
 * inside two seconds and looks compliant in every report.
 */
const REQUEST_WINDOW_MS = 60_000;

/** The actor recorded for containment nobody pressed a button to cause. */
const AUTOMATIC_ACTOR_ID = "system:external-rate-limiter";

export interface RateLimitReading {
  readonly operation: string;
  /** Requests in the window, including the one just counted. */
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
}

export interface DenialOutcome {
  readonly denialClass: DenialClass;
  /** True when this denial was written to the containment ledger. */
  readonly counted: boolean;
  /** Counting denials in the window after this one; 0 when uncounted. */
  readonly denialsInWindow: number;
  /** True when this denial was the one that contained the agent. */
  readonly contained: boolean;
}

export class RateLimiter {
  private readonly policy: RateLimitPolicy;

  constructor(
    private readonly limits: RateLimitStore,
    private readonly agents: EnrollmentStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    policy: RateLimitPolicy,
  ) {
    this.policy = assertPolicy(policy);
  }

  /**
   * Count one request and refuse if it is over the limit.
   *
   * Counting happens first and unconditionally, including for the request that
   * is about to be refused. An agent that could avoid being counted by being
   * over the limit would find that its penalty for flooding is that flooding
   * stops being measured.
   *
   * @throws {DeniedError} `ceiling.rate_exceeded` when over the limit, and
   *   `record.unavailable` when the ledger cannot be read or written — a limit
   *   we cannot enforce refuses rather than waves the request through.
   */
  async admit(agentId: ExternalAgentId, operation: string): Promise<RateLimitReading> {
    const limit = this.policy.perOperationPerMinute;

    let used: number;
    try {
      used = await this.limits.recordRequest(
        agentId,
        operation,
        this.clock.nowIso(),
        REQUEST_WINDOW_MS,
      );
    } catch (error) {
      // Fail closed. A rate limiter that cannot count is not a rate limiter,
      // and "we could not tell how many requests you have made" is not a reason
      // to serve one more. Note that this refusal is *ours*, so it must never
      // reach the containment ledger — see the class comment.
      throw new DeniedError(
        "record.unavailable",
        `The external-agent rate ledger could not be updated, so the request was refused: ${error instanceof Error ? error.message : String(error)}`,
        { agentId, operation },
      );
    }

    if (used > limit) {
      const outcome = await this.noteDenial(agentId, {
        denialClass: "misbehaviour",
        reason: `over the ${limit}-per-minute limit for ${operation}`,
      });
      throw new DeniedError(
        "ceiling.rate_exceeded",
        `External agent ${agentId} has made ${used} ${operation} requests in the last minute, past its limit of ${limit}.${outcome.contained ? " Repeated denials have contained the agent; a human must release it." : ""}`,
        {
          agentId,
          operation,
          used,
          limit,
          contained: outcome.contained,
          denialsInWindow: outcome.denialsInWindow,
        },
      );
    }

    return { operation, used, limit, remaining: Math.max(0, limit - used) };
  }

  /**
   * Record that the platform refused this agent something.
   *
   * Called by every refusal on the external plane, not only by the rate limit —
   * an agent repeatedly asking for a tool it was never granted is exactly the
   * pattern this is here to catch, and it never trips a request limit because
   * each individual attempt is cheap.
   *
   * @throws {DeniedError} `record.unavailable` if the ledger cannot be written.
   *   The caller is refusing anyway; what it must not do is refuse *and* fail
   *   to notice a pattern of refusals.
   */
  async noteDenial(
    agentId: ExternalAgentId,
    input: { readonly denialClass: DenialClass; readonly reason: string },
  ): Promise<DenialOutcome> {
    if (input.denialClass !== "misbehaviour") {
      // Deliberately not written. See the class comment: the containment
      // threshold is the ledger's only reader, and a row that must not count
      // toward it has no business being in it — a store that later decided to
      // include it would contain a team for our outage, silently.
      return {
        denialClass: input.denialClass,
        counted: false,
        denialsInWindow: 0,
        contained: false,
      };
    }

    let denials: number;
    try {
      denials = await this.limits.recordDenial(
        agentId,
        this.clock.nowIso(),
        this.policy.denialWindowMs,
        input.denialClass,
      );
    } catch (error) {
      throw new DeniedError(
        "record.unavailable",
        `A denial for external agent ${agentId} could not be recorded, so the pattern that would have contained it cannot be counted: ${error instanceof Error ? error.message : String(error)}`,
        { agentId },
      );
    }

    const contained =
      denials >= this.policy.denialsBeforeContainment
        ? await this.contain(agentId, denials, input.reason)
        : false;

    return { denialClass: input.denialClass, counted: true, denialsInWindow: denials, contained };
  }

  /**
   * Clear an agent's denial history.
   *
   * Called by the operator surface after a human releases a contained agent, so
   * that denials from before the release cannot immediately re-contain it.
   * Containment already clears the ledger; this is for the case where an
   * operator releases an agent that accumulated denials without reaching the
   * threshold.
   */
  async clearDenials(agentId: ExternalAgentId): Promise<void> {
    await this.limits.clearDenials(agentId);
  }

  /**
   * Contain an agent for a run of denials.
   *
   * Not a governed action through the chokepoint, and deliberately so. This is
   * the platform declining to keep answering a caller that keeps asking for
   * things it may not have — a refusal to serve, which is always safe and can
   * never itself cause an effect. Routing it through the chokepoint would give
   * it a role check to fail and, for a `proposed_then_approved` action, a human
   * to wait for, which would mean an agent misbehaving at three in the morning
   * kept being served until somebody woke up. Release is the governed action,
   * because release is the one that lets work resume.
   */
  private async contain(
    agentId: ExternalAgentId,
    denials: number,
    reason: string,
  ): Promise<boolean> {
    const at = this.clock.nowIso();
    const because = `automatic containment after ${denials} denials in ${Math.round(this.policy.denialWindowMs / 1000)}s: ${reason}`;

    // Conditional on `active`. An agent somebody already revoked must not be
    // walked back to `contained`, and one already contained needs nothing.
    const contained = await this.agents.setAgentStatus({
      id: agentId,
      expectedStatus: "active",
      status: "contained",
      reason: because,
      by: AUTOMATIC_ACTOR_ID,
      at,
    });
    if (!contained) return false;

    // Clear the window so the release a human is about to perform is not undone
    // by denials that were already counted once.
    await this.limits.clearDenials(agentId);

    // Effect before receipt. Containment protects the platform and the agent's
    // owner; an unreachable audit log must not leave a misbehaving agent
    // running. The write still raises if it fails, so the caller learns that
    // the receipt is missing.
    await this.audit.record(
      decision({
        eventType: "containment.engaged",
        actorId: AUTOMATIC_ACTOR_ID,
        actorKind: "system",
        actorRoles: ["system"],
        subject: { externalAgentId: agentId, principal: "external" },
        decision: {
          scope: "external_agent",
          status: "contained",
          automatic: true,
          denials,
          windowMs: this.policy.denialWindowMs,
          threshold: this.policy.denialsBeforeContainment,
          reason: because,
        },
      }),
    );

    return true;
  }
}

function assertPolicy(policy: RateLimitPolicy): RateLimitPolicy {
  if (!policy || typeof policy !== "object") {
    throw new DeniedError(
      "config.invalid",
      "The external-agent rate limiter needs a policy. Without one there is no limit, and an absent limit is not a large limit — it is no limit.",
      {},
    );
  }
  const fields: readonly (keyof RateLimitPolicy)[] = [
    "perOperationPerMinute",
    "denialsBeforeContainment",
    "denialWindowMs",
  ];
  for (const field of fields) {
    const value = policy[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new DeniedError(
        "config.invalid",
        `External-agent rate policy "${field}" must be a positive number, received: ${String(value)}.`,
        { field },
      );
    }
  }
  return policy;
}
