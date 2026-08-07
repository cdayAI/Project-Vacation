import type { Clock } from "./kernel/clock.js";
import { DeniedError } from "./kernel/errors.js";
import type { Logger } from "./kernel/logger.js";
import type { Platform } from "./platform.js";

/**
 * The thing that makes time pass.
 *
 * Every time-based mechanism in this platform was implemented, contract-tested
 * against both store adapters, and never invoked. There was no scheduler and no
 * worker: `serve` started an HTTP listener and blocked forever, and nothing
 * else ran. So a statutory deadline timer never fired, a commit abandoned by a
 * dead worker was never surfaced to anyone, an approval never expired, and the
 * used-approval ledger grew without bound.
 *
 * That is a worse class of defect than a broken sweep, because every one of
 * those mechanisms *looked* present. The runbook for a missed statutory
 * deadline pages at SEV1 for a timer that could not fire, and `pv agents
 * parked` — the operator check written to catch an abandoned write — reported
 * "all clear" over a refund that may or may not have been issued.
 *
 * Four properties, each of which is the reason a line exists here:
 *
 * **Every pass is independent.** A sweep that throws does not stop the others.
 * One unreachable table must not stop statutory timers from firing.
 *
 * **Containment stops maintenance too.** A globally paused platform is an
 * operator saying "stop", and a background loop that kept acting through a
 * pause would be the loudest possible way to ignore them. The one exception is
 * marking abandoned work indeterminate, which takes no action in the world — it
 * writes down that nobody knows, which is exactly what an operator needs during
 * an incident.
 *
 * **Nothing here retries an effect.** The sweeps close records and expire
 * claims. The single most dangerous thing a scheduler could do in this platform
 * is retry an outbound action whose outcome is unknown, so no sweep does.
 *
 * **A failure is audited, not swallowed.** A maintenance loop that fails
 * quietly is indistinguishable from one that is working.
 */

export interface MaintenancePass {
  readonly name: string;
  /**
   * True when this pass must still run while the platform is globally paused.
   *
   * Only for passes that record rather than act. Defaults false, because the
   * safe answer to "should this run during an incident" is no.
   */
  readonly runsUnderContainment?: boolean;
  run(): Promise<number>;
}

export interface MaintenanceReport {
  readonly ranAt: string;
  readonly results: readonly {
    readonly name: string;
    readonly affected: number;
    readonly skipped: boolean;
    readonly error?: string;
  }[];
}

export interface MaintenanceOptions {
  /** How often the loop runs. */
  readonly intervalMs?: number;
  /** How long a nonce claim is kept before it is purged. */
  readonly nonceRetentionMs?: number;
  /** How long a consumed approval stays in the ledger before eviction. */
  readonly approvalLedgerRetentionMs?: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_NONCE_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * Ninety days.
 *
 * Long, and deliberately so. Eviction raises the ledger's floor, and everything
 * at or below that floor is refused forever after — which is the correct
 * direction, but it means an approval granted before the cutoff can never be
 * spent. The retention window is therefore an upper bound on how long a human's
 * decision stays usable, and it should comfortably exceed how long anyone might
 * reasonably take to act on one.
 */
const DEFAULT_LEDGER_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export class MaintenanceLoop {
  private readonly intervalMs: number;
  private readonly passes: readonly MaintenancePass[];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly platform: Platform,
    private readonly logger: Logger,
    private readonly clock: Clock,
    options: MaintenanceOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const nonceRetentionMs = options.nonceRetentionMs ?? DEFAULT_NONCE_RETENTION_MS;
    const ledgerRetentionMs = options.approvalLedgerRetentionMs ?? DEFAULT_LEDGER_RETENTION_MS;

    this.passes = [
      {
        // The one that carries statutory deadlines, and therefore the one whose
        // absence the STATUTORY-TIMER-LATE runbook was paging about. It ticks
        // every instance whose next transition is due, which is what makes a
        // rescission timer fire at all.
        name: "engine.sweep",
        run: async () => {
          const result = await platform.engine.sweep();
          return result.transitions + result.tasksEscalated;
        },
      },
      {
        name: "approvals.expire",
        run: async () => (await platform.approvals.expireDue()).length,
      },
      {
        name: "external.expire_parked_actions",
        run: async () =>
          (await platform.external.stores.parked.expireParkedActions(clock.nowIso())).length,
      },
      {
        // Recording, not acting. A commit abandoned by a dead worker is exactly
        // what an operator most needs to see during an incident, and marking it
        // indeterminate performs nothing in the world — it writes down that
        // nobody knows whether the effect landed.
        name: "external.sweep_stale_commits",
        runsUnderContainment: true,
        run: async () => (await platform.external.execution.sweepStaleCommits()).length,
      },
      {
        name: "external.reclaim_stale_runs",
        runsUnderContainment: true,
        run: async () => (await platform.external.liveRuns.reclaimStale()).length,
      },
      {
        // The retention policy, discharged.
        //
        // Runs under containment? No, and the default is the right answer here
        // for a stronger reason than usual. Every other pass in this list
        // closes a record or expires a claim; this one deletes rows, and a
        // deletion cannot be undone when the incident turns out to have been
        // the reason the data was needed. An operator who has pressed stop has
        // said stop.
        name: "retention.purge",
        run: async () => {
          const report = await platform.retention.run();
          // The job keeps its rules independent and collects their failures
          // rather than throwing on the first one, so a failed rule would
          // otherwise be invisible here: the pass would report a count and look
          // healthy while a retention period went unenforced. Re-raising is
          // what puts it in the log and in `pv worker --once`'s exit code.
          const failed = report.results.filter((result) => result.error !== undefined);
          if (failed.length > 0) {
            throw new Error(
              failed.map((result) => `${result.rule}: ${result.error}`).join("; "),
            );
          }
          return report.purged;
        },
      },
      {
        name: "external.purge_nonces",
        run: async () =>
          platform.external.stores.nonces.purgeExpiredNonces(
            new Date(clock.now() - nonceRetentionMs).toISOString(),
          ),
      },
      {
        name: "external.evict_used_approvals",
        run: async () => {
          const floor = await platform.external.stores.usedApprovals.evictBefore(
            new Date(clock.now() - ledgerRetentionMs).toISOString(),
          );
          return floor === null ? 0 : 1;
        },
      },
    ];
  }

  /** Every pass this loop will run, for the CLI and the health view. */
  describe(): readonly string[] {
    return this.passes.map((pass) => pass.name);
  }

  /**
   * Run one round of maintenance.
   *
   * Returns rather than throws. The caller is a loop, and a loop that dies on
   * the first bad round stops being a scheduler — which is the failure this
   * whole file exists to prevent, arrived at from the other direction.
   */
  async runOnce(): Promise<MaintenanceReport> {
    const paused = await this.isPaused();
    const results: {
      name: string;
      affected: number;
      skipped: boolean;
      error?: string;
    }[] = [];

    for (const pass of this.passes) {
      if (paused && pass.runsUnderContainment !== true) {
        results.push({ name: pass.name, affected: 0, skipped: true });
        continue;
      }
      try {
        const affected = await pass.run();
        results.push({ name: pass.name, affected, skipped: false });
        if (affected > 0) {
          this.logger.info("maintenance pass acted", { pass: pass.name, affected });
        }
      } catch (error) {
        // Independent. One unreachable table must not stop the statutory
        // timers, and a pass that failed is worth knowing about on its own.
        const message = error instanceof Error ? error.message : String(error);
        results.push({ name: pass.name, affected: 0, skipped: false, error: message });
        this.logger.error("maintenance pass failed", { pass: pass.name, error });
      }
    }

    return { ranAt: this.clock.nowIso(), results };
  }

  /**
   * Start the loop.
   *
   * `unref` so a maintenance timer never keeps a process alive that has
   * otherwise finished — a CLI verb that runs one command and exits should not
   * hang because a scheduler is still ticking.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // A slow round must not overlap itself.
      this.running = true;
      void this.runOnce().finally(() => {
        this.running = false;
      });
    }, this.intervalMs);
    this.timer.unref?.();
    this.logger.info("maintenance loop started", {
      intervalMs: this.intervalMs,
      passes: this.passes.length,
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async isPaused(): Promise<boolean> {
    try {
      await this.platform.containment.assertClear({});
      return false;
    } catch (error) {
      if (error instanceof DeniedError) {
        // allow-swallow: converted into the boolean this method exists to
        // answer. The refusal is not lost — it decides what runs.
        return true;
      }
      throw error;
    }
  }
}
