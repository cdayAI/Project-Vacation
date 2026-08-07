import type { AuditLog } from "./audit/log.js";
import { DAY, type Clock } from "./kernel/clock.js";
import { InvariantError } from "./kernel/errors.js";
import type { Config } from "./kernel/config.js";
import type { DiscoveryCollector } from "./discovery/collect.js";
import { effectiveRetentionDays } from "./discovery/retention.js";
import type { ObservationStore } from "./improve/port.js";
import type { ActorRef, IsoTimestamp } from "./record/types.js";

/**
 * Retention, enforced rather than described.
 *
 * `docs/assurance/retention-and-deletion.md` is an assurance artifact: it is
 * the document a privacy reviewer is handed, and for a while it stated in the
 * present tense that a purge job ran daily, recorded its runs in the audit
 * chain, and had three tested properties. None of that existed. A stale comment
 * is a nuisance; a false statement in that document is a false statement to a
 * buyer, and `PV_AUDIT_RETENTION_DAYS` was a knob an operator could set in the
 * belief that a retention period was being enforced by something.
 *
 * This is that something. Four properties, and the fourth is the one that
 * matters most:
 *
 * **It is idempotent.** A second run inside the same window finds nothing past
 * its cut-off, deletes nothing, writes nothing to the chain, and is not an
 * error. The loop that drives it runs every minute.
 *
 * **It is bounded.** A rule deletes at most `batchLimit` rows per run, oldest
 * first, so a purge cannot hold locks on a table for an unbounded time and a
 * backlog drains across runs instead of in one statement. One rule is exempt
 * and says so at its definition: work-discovery observations carry a
 * per-enrollment cut-off that a row cap cannot express, over a table bounded at
 * thirty days of a feature that ships disabled.
 *
 * **It fails closed.** The count is taken, the `retention.purged` entry is
 * written, and only then are rows deleted. A chain that cannot be appended to
 * therefore stops the deletion. The residual is stated plainly: a crash between
 * the write and the delete leaves the chain claiming a purge that did not
 * finish, and the next run deletes the remainder and records again. That is
 * over-recording, which is the safe direction — deleting without a record of
 * the deletion is precisely what the audit chain exists to prevent.
 *
 * **It never deletes an audit entry.** The chain is the evidence. Removing an
 * entry breaks verification for that entry and every one after it, and the
 * head watermark exists specifically to detect deletion from the end — so a
 * retention job that trimmed the chain would defeat both the tamper-evidence
 * and the check built to catch exactly that shape of deletion. There is no
 * deletion operation on `AuditStore` at all, so this is structural rather than
 * a matter of care; `assertNeverTheAuditChain` is a tripwire for whoever is
 * tempted to add one. Where the retention document implied the chain would be
 * pruned, the document was wrong and has been corrected: pruning waits on the
 * archival job, which is not built.
 */

/** The instant before which a rule's rows are due for deletion. */
export type Cutoff = IsoTimestamp;

export interface RetentionRule {
  /** Stable identifier, recorded in the audit entry. */
  readonly name: string;
  /** The row of `docs/assurance/data-inventory.md` §1 this discharges. */
  readonly category: string;
  /** The period in force after clamping, in whole days. */
  readonly periodDays: number;
  /** Which timestamp the period runs from, for the audit entry. */
  readonly basis: string;
  /** The instant before which rows are due, computed from the clock. */
  cutoff(): Cutoff;
  /** How many rows are past their period right now. */
  countDue(): Promise<number>;
  /** Delete at most `limit` rows past their period. Returns how many went. */
  purge(limit: number): Promise<number>;
}

export interface RetentionRuleResult {
  readonly rule: string;
  readonly cutoff: Cutoff;
  /** Rows found past their period before anything was deleted. */
  readonly due: number;
  readonly purged: number;
  readonly error?: string;
}

export interface RetentionReport {
  readonly ranAt: IsoTimestamp;
  readonly purged: number;
  readonly results: readonly RetentionRuleResult[];
}

export interface RetentionOptions {
  /**
   * Rows one rule may delete in one run.
   *
   * Five hundred, not five thousand: the ceiling that matters is how long a
   * single statement holds locks on a table the console reads, not how quickly
   * a backlog drains. A backlog drains anyway, because the loop runs every
   * minute.
   */
  readonly batchLimit?: number;
}

const DEFAULT_BATCH_LIMIT = 500;

/**
 * The actor a purge is attributed to.
 *
 * Not a person and not a service account. Nobody approved this deletion in the
 * moment; a configured period did, and the record should say so rather than
 * implying somebody pressed something.
 */
const RETENTION_ACTOR: ActorRef = {
  actorId: "system:retention",
  kind: "system",
  roles: ["system"],
};

/**
 * Rule names this job must never be given.
 *
 * A tripwire, not the control. The control is that `AuditStore` exposes no
 * deletion operation, so there is nothing here that *could* delete an entry.
 * This exists for the day somebody adds one and reaches for the retention job
 * as the obvious caller — at which point the deployment refuses to start rather
 * than quietly beginning to trim its own evidence.
 */
const FORBIDDEN_RULE_PREFIXES = ["audit", "chain"] as const;

function assertNeverTheAuditChain(rules: readonly RetentionRule[]): void {
  const offenders = rules
    .map((rule) => rule.name)
    .filter((name) => FORBIDDEN_RULE_PREFIXES.some((prefix) => name.startsWith(prefix)));
  if (offenders.length > 0) {
    throw new InvariantError(
      `Retention rules may not target the audit chain: ${offenders.join(", ")}. The chain is append-only evidence — deleting an entry breaks verification for every entry after it, and the head watermark exists to detect exactly that. Pruning the chain is specified in docs/assurance/retention-and-deletion.md §3 and waits on the archival job, which is not built.`,
    );
  }
}

export class RetentionPurgeJob {
  private readonly batchLimit: number;

  constructor(
    private readonly rules: readonly RetentionRule[],
    private readonly audit: AuditLog,
    private readonly clock: Clock,
    options: RetentionOptions = {},
  ) {
    assertNeverTheAuditChain(rules);
    this.batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  }

  /** Every rule this job enforces, for the CLI and the operator guide. */
  describe(): readonly { readonly name: string; readonly periodDays: number }[] {
    return this.rules.map((rule) => ({ name: rule.name, periodDays: rule.periodDays }));
  }

  /**
   * Apply every rule once.
   *
   * Rules are independent: one that throws is reported and the rest still run.
   * A single unreachable table must not stop a different category of personal
   * data from being deleted on time.
   */
  async run(): Promise<RetentionReport> {
    const results: RetentionRuleResult[] = [];
    let purged = 0;

    for (const rule of this.rules) {
      const cutoff = rule.cutoff();
      try {
        const due = await rule.countDue();
        if (due === 0) {
          // Idempotent, and quiet. Recording "nothing was due" once a minute
          // for every rule would add half a million entries a year to a chain
          // that has to stay cheap to verify, and would bury the entries that
          // record an actual deletion.
          results.push({ rule: rule.name, cutoff, due: 0, purged: 0 });
          continue;
        }

        const limit = Math.min(due, this.batchLimit);

        // Written before anything is deleted. See the class comment: this is
        // what makes an unwritable chain stop the purge rather than produce an
        // unrecorded one.
        await this.audit.record({
          eventType: "retention.purged",
          actor: RETENTION_ACTOR,
          subject: { rule: rule.name, category: rule.category },
          inputDigests: {},
          decision: {
            cutoff,
            periodDays: rule.periodDays,
            basis: rule.basis,
            rowsDue: due,
            rowsAttempted: limit,
          },
        });

        const deleted = await rule.purge(limit);
        purged += deleted;
        results.push({ rule: rule.name, cutoff, due, purged: deleted });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ rule: rule.name, cutoff, due: 0, purged: 0, error: message });
      }
    }

    return { ranAt: this.clock.nowIso(), purged, results };
  }
}

/** What `buildRetentionRules` needs. Only the stores that can actually delete. */
export interface RetentionSources {
  readonly config: Config;
  readonly clock: Clock;
  /** Improvement observations — data inventory D10. */
  readonly observations: ObservationStore;
  /** Work-discovery observations — data inventory D11. */
  readonly discovery: DiscoveryCollector;
}

/**
 * The period the improvement loop's observations are kept.
 *
 * Two years, from `docs/assurance/data-inventory.md` §3: quality trend
 * analysis, with no evidentiary requirement beyond the audit entry that already
 * records the correction happened.
 */
export const IMPROVEMENT_OBSERVATION_DAYS = 730;

/**
 * Clamp a stated period to the deployment's overall retention period.
 *
 * This is what makes `PV_AUDIT_RETENTION_DAYS` a control rather than a label.
 * It is the longest period this deployment keeps anything, so a deployment that
 * shortens it shortens every rule with it — an operator who sets it to a year
 * gets a year, not a year for the chain and two years for everything measured
 * against the chain. It can only shorten: a rule with a shorter period of its
 * own keeps it.
 */
export function effectivePeriodDays(statedDays: number, config: Config): number {
  return Math.max(1, Math.min(statedDays, config.auditRetentionDays));
}

function cutoffFor(clock: Clock, days: number): Cutoff {
  return new Date(clock.now() - days * DAY).toISOString();
}

/**
 * The rules this platform can actually discharge today.
 *
 * Short, and honestly so. A rule belongs here only when the platform holds the
 * data, can delete it without leaving a dangling reference, and the composition
 * root can reach the store that owns it. `retention-and-deletion.md` §5 records
 * every row of the policy table that fails one of those three tests and why —
 * the operating record fails the second, because six tables across four modules
 * reference `run` with `ON DELETE RESTRICT` and three of them have no stated
 * period yet.
 */
export function buildRetentionRules(sources: RetentionSources): readonly RetentionRule[] {
  const { config, clock, observations, discovery } = sources;

  const improvementDays = effectivePeriodDays(IMPROVEMENT_OBSERVATION_DAYS, config);
  // Through the discovery clamp as well as the platform one, so the number
  // reported is the number enforced even if a stored or configured value has
  // somehow got past the thirty-day ceiling.
  const discoveryDays = effectiveRetentionDays(
    effectivePeriodDays(config.discoveryRetentionDays, config),
  );

  const rules: RetentionRule[] = [
    {
      name: "improvement.observations",
      category: "D10",
      periodDays: improvementDays,
      basis: "recordedAt",
      cutoff: () => cutoffFor(clock, improvementDays),
      countDue: () =>
        observations.countObservations({ recordedBefore: cutoffFor(clock, improvementDays) }),
      purge: (limit) =>
        observations.purgeObservationsBefore(cutoffFor(clock, improvementDays), limit),
    },
    {
      // The sharpest row in the inventory. These are observations of employees,
      // and the thirty-day ceiling is asserted to MVW in two assurance
      // documents, checked at configuration load, clamped again at purge time,
      // and enforced by a CHECK constraint in the schema — by everything, in
      // short, except anything that ran. `DiscoveryCollector.purgeExpired` was
      // written, tested, and never called, so the ceiling was a promise kept by
      // nobody. This is its caller.
      //
      // It runs whether or not the feature is enabled, because the rows that
      // most need deleting belong to a deployment that switched observation on
      // and then off again.
      name: "discovery.observations",
      category: "D11",
      periodDays: discoveryDays,
      basis: "observedAt",
      cutoff: () => cutoffFor(clock, discoveryDays),
      countDue: () => discovery.countExpired(config.auditRetentionDays),
      // Deliberately not capped by `limit`. The collector applies a
      // per-enrollment cut-off on top of the deployment one, which a row cap
      // cannot express without losing the shorter periods individual people
      // chose. The table is bounded at thirty days of a disabled feature, so
      // there is no backlog for a cap to protect against.
      purge: () => discovery.purgeExpired(config.auditRetentionDays),
    },
  ];

  return rules;
}
