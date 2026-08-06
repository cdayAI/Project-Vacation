import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { Logger } from "../kernel/logger.js";
import { redactText } from "../kernel/redact.js";
import type { IntegrationQueueStore } from "./port.js";
import type { ParkedItem, QueuedCall } from "./types.js";

/**
 * Explicit degradation.
 *
 * The rule this file enforces is one sentence: **a failing integration never
 * silently produces a worse answer.** No cached value presented as current, no
 * partial result presented as complete, no default substituted for a fact
 * nobody could read. Those are the failures that survive review, because the
 * output looks exactly like a correct one — a rescission deadline computed
 * from a stale disclosure date is indistinguishable from a right answer until
 * someone misses the window.
 *
 * So the caller chooses, up front, which of three things happens instead, and
 * every one of them is visible:
 *
 *   `queue`            The work is durable and will be attempted again. The
 *                      caller gets `kind: "queued"` and must not report
 *                      success. Suitable when nobody is waiting and the
 *                      failure is plausibly transient.
 *
 *   `park_for_human`   The work goes onto a person's queue with enough context
 *                      to act on. Suitable when the answer is needed and a
 *                      person can obtain it another way — which, for a
 *                      statutory deadline, is usually the right choice.
 *
 *   `refuse`           The action stops now, with a denial. Suitable when
 *                      proceeding without the data would be worse than not
 *                      proceeding at all.
 *
 * Two rules about what is *not* degraded.
 *
 * *A refusal is never degraded.* A `DeniedError` — an unallowlisted host, a
 * revoked credential, a contained integration, a rate ceiling — is a policy
 * decision, not a transient fault. Queueing one would retry a policy decision
 * every few minutes forever, and parking one would put a governance refusal on
 * a person's queue as though it were an outage. Denials propagate unchanged
 * whatever policy was chosen.
 *
 * *A queue that gives up parks rather than dropping.* When a queued call has
 * exhausted its attempts it becomes a parked item, not a deleted row. An
 * effect that quietly stopped being attempted is the same failure as a silent
 * wrong answer, with fewer traces.
 *
 * On the audit log: degradation is recorded here in the queue and parked-item
 * tables, and by the failed step the egress client has already written. It is
 * deliberately *not* forced into an audit event, because the shared event
 * vocabulary has no integration-degradation event and mapping it onto
 * `model.degraded` would make the audit view assert something untrue. If MVW
 * wants degradation in the chain, the right change is a new event type, agreed
 * once, rather than a convenient reuse.
 */

export const DEGRADATION_POLICIES = ["queue", "park_for_human", "refuse"] as const;
export type DegradationPolicy = (typeof DEGRADATION_POLICIES)[number];

export interface DegradationContext {
  readonly integration: string;
  /** Logical operation, e.g. `contract-records.getContract`. */
  readonly operation: string;
  /**
   * Identifies this logical call.
   *
   * Used as the queue key and the parked-item reference, so retrying a failed
   * call does not stack up queue entries and parking twice does not produce
   * two items for one problem.
   */
  readonly idempotencyKey: string;
  /** Opaque references describing the target. Never owner personal data. */
  readonly subject?: Readonly<Record<string, string>> | undefined;
  readonly runId?: Id<"run"> | undefined;
  /** What a person needs to pick this up. Non-sensitive, human-readable. */
  readonly summary: string;
  readonly correlationId?: string | undefined;
}

export type DegradationOutcome<T> =
  | { readonly kind: "succeeded"; readonly value: T }
  | { readonly kind: "queued"; readonly item: QueuedCall }
  | { readonly kind: "parked"; readonly item: ParkedItem };

export interface DegradationOptions {
  /** Attempts a queued call gets before it is parked for a person. */
  readonly maxQueueAttempts?: number | undefined;
  readonly baseBackoffMs?: number | undefined;
  readonly maxBackoffMs?: number | undefined;
  readonly logger?: Logger | undefined;
}

const DEFAULTS = {
  maxQueueAttempts: 5,
  baseBackoffMs: 60_000,
  maxBackoffMs: 6 * 60 * 60 * 1000,
} as const;

export class DegradationHandler {
  private readonly maxQueueAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly store: IntegrationQueueStore,
    private readonly clock: Clock,
    private readonly options: DegradationOptions = {},
  ) {
    this.maxQueueAttempts = options.maxQueueAttempts ?? DEFAULTS.maxQueueAttempts;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
  }

  /**
   * Run an integration call under an explicit degradation policy.
   *
   * @throws {DeniedError} unchanged, when the operation was refused rather
   *   than failed — whatever the policy — and when the policy is `refuse`.
   */
  async run<T>(
    policy: DegradationPolicy,
    context: DegradationContext,
    operation: () => Promise<T>,
  ): Promise<DegradationOutcome<T>> {
    try {
      return { kind: "succeeded", value: await operation() };
    } catch (error) {
      // A refusal is not a fault. Re-raised before any policy applies, so no
      // policy can convert a governance decision into a retry loop.
      if (error instanceof DeniedError) throw error;

      const message = redactText(
        error instanceof Error ? error.message : String(error),
      ).text.slice(0, 1024);

      this.options.logger?.warn("integration degraded", {
        integration: context.integration,
        operation: context.operation,
        policy,
        error: message,
      });

      switch (policy) {
        case "queue":
          return this.queue(context, message);
        case "park_for_human":
          return { kind: "parked", item: await this.park(context, message) };
        case "refuse":
          throw new DeniedError(
            "record.unavailable",
            `"${context.operation}" could not be completed because ${context.integration} did not answer, and the caller chose to refuse rather than proceed without it: ${message}`,
            { integration: context.integration, operation: context.operation },
          );
        default: {
          // An unrecognised policy is a programming error, and the safe
          // reading of one is the most conservative branch.
          const exhaustive: never = policy;
          void exhaustive;
          throw new DeniedError(
            "record.unavailable",
            `Unknown degradation policy for "${context.operation}"; refusing.`,
            { integration: context.integration },
          );
        }
      }
    }
  }

  private async queue<T>(
    context: DegradationContext,
    error: string,
  ): Promise<DegradationOutcome<T>> {
    const nowIso = this.clock.nowIso();
    const existing = await this.store.getQueued(context.idempotencyKey);
    const attempts = (existing?.attempts ?? 0) + 1;

    if (attempts > this.maxQueueAttempts) {
      // The queue has run out of patience. Parking rather than dropping: an
      // effect that stopped being attempted with nobody told is the same
      // failure as a silent wrong answer.
      const parked = await this.park(
        context,
        `${error} (abandoned after ${attempts - 1} queued attempts)`,
      );
      await this.store.releaseQueued(context.idempotencyKey, nowIso, error, null);
      return { kind: "parked", item: parked };
    }

    const backoff = Math.min(this.baseBackoffMs * 2 ** (attempts - 1), this.maxBackoffMs);
    const item = await this.store.enqueue({
      idempotencyKey: context.idempotencyKey,
      integration: context.integration,
      operation: context.operation,
      subject: context.subject ?? {},
      runId: context.runId,
      status: "queued",
      attempts,
      firstFailedAt: existing?.firstFailedAt ?? nowIso,
      lastAttemptAt: nowIso,
      nextAttemptAt: new Date(this.clock.now() + backoff).toISOString(),
      lastError: error,
    });
    return { kind: "queued", item };
  }

  private park(context: DegradationContext, reason: string): Promise<ParkedItem> {
    return this.store.park({
      reference: context.idempotencyKey,
      integration: context.integration,
      operation: context.operation,
      subject: context.subject ?? {},
      runId: context.runId,
      summary: context.summary,
      reason,
      parkedAt: this.clock.nowIso(),
    });
  }

  /**
   * Claim queued calls whose next attempt is due.
   *
   * The scheduler re-invokes whatever handler is registered for the item's
   * `integration` and `operation`. Deliberately not a closure replay: a queue
   * that stores executable state makes every pending item a compatibility
   * constraint on the next deployment.
   */
  claimDue(limit = 20): Promise<readonly QueuedCall[]> {
    return this.store.claimDue(this.clock.nowIso(), limit);
  }

  completeQueued(idempotencyKey: string): Promise<QueuedCall | null> {
    return this.store.completeQueued(idempotencyKey, this.clock.nowIso());
  }

  listParked(
    filter?: Parameters<IntegrationQueueStore["listParked"]>[0],
  ): Promise<readonly ParkedItem[]> {
    return this.store.listParked(filter);
  }

  resolveParked(
    reference: string,
    by: string,
    resolution: string,
  ): Promise<ParkedItem | null> {
    return this.store.resolveParked(reference, this.clock.nowIso(), by, resolution);
  }
}
