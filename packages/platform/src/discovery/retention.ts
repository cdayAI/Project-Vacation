import { DAY } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import type { IsoTimestamp } from "../record/types.js";

/**
 * Retention, with a ceiling nobody can raise from configuration.
 *
 * Work-discovery observations answer a question about *this month's* process,
 * not a question about a person's year. Months of transition history is a
 * behavioural profile; a fortnight is a sample. So retention is measured in
 * days, and the maximum is in code rather than in configuration — a value an
 * operator can set is a value that grows quietly, one reasonable-sounding
 * request at a time, until somebody discovers eighteen months of employee
 * timing data during discovery in a lawsuit.
 *
 * Two layers, deliberately:
 *
 *   `assertRetentionWithinCeiling` refuses a configured value over the ceiling
 *   outright. It guards the enrollment path (`EnrollmentService`), where a
 *   request for ninety days is told no rather than silently accepted. It does
 *   NOT guard process startup: the composition root builds the collector's
 *   settings through the clamp below rather than through this refusal (the
 *   reasoning is written out at the call site in `platform.ts`), so an
 *   over-ceiling `PV_DISCOVERY_RETENTION_DAYS` shortens the purge to the ceiling
 *   instead of failing the boot. The ceiling therefore always holds — thirty
 *   days is the most that is ever kept — but a startup value past it is clamped,
 *   not refused. A caller that wants a configured value refused rather than
 *   clamped uses `discoverySettings`, or this function directly.
 *
 *   `effectiveRetentionDays` clamps whatever it is handed. This is not dead
 *   code behind the assertion: enrollments carry their own retention value and
 *   live in a database that a migration, a restore, or a psql prompt can
 *   change. The purge computes its cut-off through the clamp, so a row saying
 *   `retention_days = 3650` still purges at thirty days.
 */

/**
 * The hard ceiling: 30 days.
 *
 * Stated in `docs/assurance/retention-and-deletion.md` and in
 * `docs/assurance/data-inventory.md`, and enforced here, in the enrollment
 * path, and by a CHECK constraint in the schema. Three places, because the
 * claim is made to MVW in writing and a claim enforced in one place is a claim
 * enforced until somebody refactors that place.
 */
export const MAX_RETENTION_DAYS = 30;

/** Retention must be at least a day; below that nothing can be mined at all. */
export const MIN_RETENTION_DAYS = 1;

/** What the collector needs from configuration, and nothing more. */
export interface DiscoverySettings {
  /** `PV_DISCOVERY_ENABLED`. Defaults to false and ships false. */
  readonly enabled: boolean;
  /** `PV_DISCOVERY_RETENTION_DAYS`, already checked against the ceiling. */
  readonly retentionDays: number;
}

/**
 * Refuse a retention period longer than the ceiling.
 *
 * @throws {DeniedError} `config.invalid`
 */
export function assertRetentionWithinCeiling(days: number, source = "configuration"): void {
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS) {
    throw new DeniedError(
      "config.invalid",
      `Work-discovery retention must be a whole number of days, at least ${MIN_RETENTION_DAYS} — ${source} supplied ${String(days)}.`,
      { source, days: String(days) },
    );
  }
  if (days > MAX_RETENTION_DAYS) {
    throw new DeniedError(
      "config.invalid",
      `Work-discovery retention of ${days} days exceeds the ${MAX_RETENTION_DAYS}-day ceiling, which is fixed in code and not a configurable value. Observations of employees are kept for days, not months; a longer period turns a process sample into a behavioural profile.`,
      { source, days, ceiling: MAX_RETENTION_DAYS },
    );
  }
}

/**
 * Clamp a retention period to the ceiling.
 *
 * Never throws, so the purge cannot be disabled by a bad stored value: a row
 * carrying nonsense is treated as the shortest sane period rather than as a
 * reason to skip deleting anything.
 */
export function effectiveRetentionDays(days: number): number {
  if (!Number.isFinite(days)) return MIN_RETENTION_DAYS;
  const whole = Math.floor(days);
  if (whole < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS;
  return Math.min(whole, MAX_RETENTION_DAYS);
}

/**
 * Build settings from configuration, refusing an over-long retention period.
 *
 * Takes the two fields it needs rather than the whole `Config`, so a test can
 * construct settings without building a deployment.
 */
export function discoverySettings(input: {
  readonly discoveryEnabled: boolean;
  readonly discoveryRetentionDays: number;
}): DiscoverySettings {
  assertRetentionWithinCeiling(input.discoveryRetentionDays, "PV_DISCOVERY_RETENTION_DAYS");
  return Object.freeze({
    enabled: input.discoveryEnabled === true,
    retentionDays: input.discoveryRetentionDays,
  });
}

/** The instant before which observations must no longer exist. */
export function retentionCutoff(now: number, days: number): IsoTimestamp {
  return new Date(now - effectiveRetentionDays(days) * DAY).toISOString();
}
