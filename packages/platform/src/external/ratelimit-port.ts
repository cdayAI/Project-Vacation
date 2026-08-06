import type { DenialClass, ExternalAgentId } from "./types.js";

/**
 * The slice of the rate limiter the admission chain depends on.
 *
 * Narrow on purpose. The admission chain is the security-critical path and
 * should not be coupled to the limiter's containment bookkeeping, its window
 * accounting, or its store — it needs two questions answered and nothing else.
 * Keeping the seam here also means the two can be built and tested
 * independently.
 */
export interface RateLimiterLike {
  /** Count this request and say whether it is within the per-operation ceiling. */
  check(
    agentId: ExternalAgentId,
    operation: string,
  ): Promise<{ readonly allowed: boolean; readonly count: number }>;

  /**
   * Record a denial.
   *
   * Only `misbehaviour` denials reach here from the admission chain. Repeated
   * misbehaviour inside the window auto-contains the agent until a human
   * releases it; our own infrastructure failures are excluded upstream, because
   * containing a team for our outage punishes them for our problem.
   */
  recordDenial(agentId: ExternalAgentId, denialClass: DenialClass): Promise<void>;
}
