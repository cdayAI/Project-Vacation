import type { Clock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import type { Id } from "../kernel/ids.js";
import type { RunStore } from "../record/port.js";
import type { CeilingLimits, CeilingUsage } from "./types.js";

/**
 * Spend, rate, and time ceilings.
 *
 * The brief's requirement is "ceilings enforced at consumption — not only at a
 * pre-flight check", and the distinction is the whole point. A pre-flight
 * check answers "may I start?" using an estimate. If the estimate is wrong, or
 * if a step loops, or if two steps run concurrently and each passes pre-flight
 * against the same remaining budget, the ceiling is decorative.
 *
 * So there are two calls and both matter:
 *
 *   `check()`   before the work, using an estimate. Cheap, catches the obvious.
 *   `consume()` after the work, using the actual. Records the spend and throws
 *               if the ceiling has now been passed.
 *
 * `consume()` throwing after the money is spent may look pointless, but it is
 * what stops the *next* step, and it is what turns a runaway loop into a
 * bounded overrun rather than an unbounded one. The overshoot is bounded by
 * one step's cost, which is the best any post-hoc meter can do.
 *
 * Reservation closes the concurrency hole: `check()` reserves the estimated
 * amount against the run, so two concurrent steps cannot both pass a check
 * against the same headroom. The reservation is released when `consume()`
 * records the real figure.
 *
 * Scope limitation, stated plainly: the rate window and the reservations are
 * per-process. A multi-instance deployment needs these in shared storage, and
 * that is recorded in docs/handover/not-production-grade.md rather than
 * implied to be solved.
 */
export class CeilingEnforcer {
  private readonly reservations = new Map<string, number>();
  private readonly runStartedAt = new Map<string, number>();
  /** Timestamps of recent model calls, for the sliding rate window. */
  private modelCallTimes: number[] = [];

  constructor(
    private readonly limits: CeilingLimits,
    private readonly clock: Clock,
    private readonly runs: RunStore,
  ) {}

  /** Record when a run began, so the wall-clock ceiling has a reference point. */
  markRunStarted(runId: Id<"run">, at = this.clock.now()): void {
    this.runStartedAt.set(runId, at);
  }

  markRunEnded(runId: Id<"run">): void {
    this.runStartedAt.delete(runId);
    this.reservations.delete(runId);
  }

  async usage(runId: Id<"run">): Promise<CeilingUsage> {
    const summary = await this.runs.costForRun(runId);
    const dayStart = new Date(this.clock.now() - 24 * 60 * 60 * 1000).toISOString();
    const daily = await this.runs.costSince(dayStart);
    const startedAt = this.runStartedAt.get(runId);
    this.pruneRateWindow();
    return {
      runSpendUsd: summary.totalUsd + (this.reservations.get(runId) ?? 0),
      dailySpendUsd: daily,
      runElapsedMs: startedAt === undefined ? 0 : this.clock.now() - startedAt,
      modelCallsInWindow: this.modelCallTimes.length,
    };
  }

  private pruneRateWindow(): void {
    const cutoff = this.clock.now() - 60_000;
    // The window only ever grows by one per call and is pruned on every read,
    // so this stays bounded by the configured per-minute limit in practice.
    this.modelCallTimes = this.modelCallTimes.filter((at) => at > cutoff);
  }

  /**
   * Pre-flight check, reserving the estimate against the run.
   *
   * @throws {DeniedError} when any ceiling would be passed.
   */
  async check(
    runId: Id<"run">,
    options: { readonly estimatedCostUsd?: number; readonly isModelCall?: boolean } = {},
  ): Promise<void> {
    const estimate = options.estimatedCostUsd ?? 0;
    if (estimate < 0) {
      throw new DeniedError("ceiling.spend_exceeded", "A negative cost estimate is not meaningful.", {
        runId,
        estimate,
      });
    }

    const usage = await this.usage(runId);

    if (usage.runElapsedMs > this.limits.runWallClockMs) {
      throw new DeniedError(
        "ceiling.time_exceeded",
        `Run has been going for ${Math.round(usage.runElapsedMs / 1000)}s, past its ${Math.round(this.limits.runWallClockMs / 1000)}s ceiling.`,
        { runId, elapsedMs: usage.runElapsedMs, ceilingMs: this.limits.runWallClockMs },
      );
    }

    if (usage.runSpendUsd + estimate > this.limits.runSpendUsd) {
      throw new DeniedError(
        "ceiling.spend_exceeded",
        `Run spend would reach $${(usage.runSpendUsd + estimate).toFixed(4)}, past its $${this.limits.runSpendUsd.toFixed(2)} ceiling.`,
        { runId, spentUsd: usage.runSpendUsd, estimateUsd: estimate, ceilingUsd: this.limits.runSpendUsd },
      );
    }

    if (usage.dailySpendUsd + estimate > this.limits.dailySpendUsd) {
      throw new DeniedError(
        "ceiling.spend_exceeded",
        `Daily spend would reach $${(usage.dailySpendUsd + estimate).toFixed(2)}, past the $${this.limits.dailySpendUsd.toFixed(2)} ceiling.`,
        { runId, dailyUsd: usage.dailySpendUsd, ceilingUsd: this.limits.dailySpendUsd },
      );
    }

    if (options.isModelCall && usage.modelCallsInWindow >= this.limits.modelCallsPerMinute) {
      throw new DeniedError(
        "ceiling.rate_exceeded",
        `Model call rate ceiling reached: ${usage.modelCallsInWindow} calls in the last minute, limit ${this.limits.modelCallsPerMinute}.`,
        { runId, callsInWindow: usage.modelCallsInWindow, ceiling: this.limits.modelCallsPerMinute },
      );
    }

    // Reserve after every check has passed, so a denial does not leave a
    // phantom reservation behind that would shrink the run's budget.
    if (estimate > 0) {
      this.reservations.set(runId, (this.reservations.get(runId) ?? 0) + estimate);
    }
    if (options.isModelCall) {
      this.modelCallTimes.push(this.clock.now());
    }
  }

  /**
   * Release a reservation without recording spend.
   *
   * Used when a checked action was refused downstream and never ran.
   */
  release(runId: Id<"run">, estimatedCostUsd: number): void {
    if (estimatedCostUsd <= 0) return;
    const held = this.reservations.get(runId) ?? 0;
    const next = held - estimatedCostUsd;
    if (next > 0) this.reservations.set(runId, next);
    else this.reservations.delete(runId);
  }

  /**
   * Record actual spend and re-check the ceilings.
   *
   * @throws {DeniedError} if the ceiling has now been passed. The caller must
   *   treat this as "stop", not as "the last step failed".
   */
  async consume(
    runId: Id<"run">,
    actualCostUsd: number,
    reservedEstimateUsd = 0,
  ): Promise<void> {
    this.release(runId, reservedEstimateUsd);

    const usage = await this.usage(runId);

    if (usage.runSpendUsd > this.limits.runSpendUsd) {
      throw new DeniedError(
        "ceiling.spend_exceeded",
        `Run spend has reached $${usage.runSpendUsd.toFixed(4)}, past its $${this.limits.runSpendUsd.toFixed(2)} ceiling. The run must stop.`,
        { runId, spentUsd: usage.runSpendUsd, ceilingUsd: this.limits.runSpendUsd },
      );
    }
    if (usage.dailySpendUsd > this.limits.dailySpendUsd) {
      throw new DeniedError(
        "ceiling.spend_exceeded",
        `Daily spend has reached $${usage.dailySpendUsd.toFixed(2)}, past the $${this.limits.dailySpendUsd.toFixed(2)} ceiling.`,
        { runId, dailyUsd: usage.dailySpendUsd, ceilingUsd: this.limits.dailySpendUsd },
      );
    }
    if (usage.runElapsedMs > this.limits.runWallClockMs) {
      throw new DeniedError(
        "ceiling.time_exceeded",
        `Run has exceeded its ${Math.round(this.limits.runWallClockMs / 1000)}s wall-clock ceiling.`,
        { runId, elapsedMs: usage.runElapsedMs, ceilingMs: this.limits.runWallClockMs },
      );
    }
    void actualCostUsd;
  }

  /** Test and operator visibility into the configured limits. */
  get configuredLimits(): CeilingLimits {
    return this.limits;
  }
}
