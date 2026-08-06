import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import {
  addDays,
  compareCivilDates,
  formatCivilDate,
  formatInstant,
  localDateAt,
  parseIsoInstant,
} from "./calendar.js";
import type { AppliedTolling, IsoDate, TollingEvent } from "./types.js";

/**
 * Tolling: the events that pause, restart, or lengthen a statutory clock.
 *
 * Tolling is where rescission deadlines actually go wrong, because it is the
 * part that gets handled by hand. Somebody re-delivers a corrected disclosure
 * package, somebody writes "clock restarted" in a case note, and six months
 * later nobody can say from what instant, on whose authority, or whether the
 * days before the correction still counted.
 *
 * So tolling here is not a nullable date field on a contract. It is a list of
 * declared events, each carrying its reason, the instrument that authorises it,
 * and who recorded it, resolved into a plan by a function whose output is
 * itself part of the derivation record.
 *
 * Three kinds, and the differences between them are legal, not cosmetic:
 *
 *   `suspend`  the clock pauses; the paused days do not count and the window
 *              finishes later by however many days were paused.
 *   `restart`  the clock begins again from a new trigger; days already counted
 *              are discarded.
 *   `extend`   the window itself is longer; nothing about the trigger changes.
 *
 * Every bound in this file is deliberate. Tolling is caller-supplied data, and
 * a deadline is a control that a long enough extension quietly disables — so
 * "extend by 100000 days" is refused rather than honoured. A control that can
 * be evaded by padding one field is not a control.
 */

/** Most tolling events one computation will consider. */
export const MAX_TOLLING_EVENTS = 50;

/** Longest single suspension or extension, in days. */
export const MAX_TOLLING_DAYS = 365;

/** Longest total extension across all `extend` events. */
export const MAX_TOTAL_EXTENSION_DAYS = 365;

export interface TollingPlan {
  /** Instant the clock restarts from, if any event restarted it. */
  readonly restartAt: number | null;
  /** Local civil dates that do not count, because the clock was paused. */
  readonly suspendedDates: ReadonlySet<IsoDate>;
  /** Whole days added to the window length. */
  readonly extraDays: number;
  readonly applied: readonly AppliedTolling[];
  readonly warnings: readonly string[];
}

function refuse(message: string, detail: Record<string, string | number | boolean> = {}): DeniedError {
  return new DeniedError("knowledge.no_grounding", message, detail);
}

function instantOf(value: string | undefined, field: string, code: string): number {
  if (value === undefined) {
    throw refuse(
      `Tolling event "${code}" is missing ${field}. A clock cannot be adjusted from an unstated moment.`,
      { field, code },
    );
  }
  try {
    return parseIsoInstant(value, field);
  } catch (error) {
    throw refuse(
      `Tolling event "${code}" has an unusable ${field}: ${error instanceof InvalidInputError ? error.message : String(error)}`,
      { field, code },
    );
  }
}

/**
 * Resolve declared tolling events into their effect on one clock.
 *
 * `triggerInstant` is the untolled trigger. Events are applied in ascending
 * order of effect so the result does not depend on the order the caller
 * happened to store them in — the same events in a different order must produce
 * the same deadline, or the deadline is not reproducible.
 *
 * @throws {DeniedError} `knowledge.no_grounding` when an event is unusable.
 *   A malformed tolling event is refused rather than skipped: skipping it would
 *   silently produce the untolled deadline, which is the shorter one.
 */
export function planTolling(
  events: readonly TollingEvent[],
  timeZone: string,
  triggerInstant: number,
): TollingPlan {
  if (events.length > MAX_TOLLING_EVENTS) {
    throw refuse(
      `${events.length} tolling events were supplied, past the ${MAX_TOLLING_EVENTS}-event limit. A contract with this many adjustments needs a human derivation, not an automated one.`,
      { count: events.length, limit: MAX_TOLLING_EVENTS },
    );
  }

  const applied: AppliedTolling[] = [];
  const warnings: string[] = [];
  const suspendedDates = new Set<IsoDate>();
  let restartAt: number | null = null;
  let extraDays = 0;

  const ordered = [...events]
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const left = Date.parse(a.event.effectiveAt);
      const right = Date.parse(b.event.effectiveAt);
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
      // Stable on ties so the derivation is byte-identical across runs.
      return a.index - b.index;
    })
    .map((wrapped) => wrapped.event);

  for (const event of ordered) {
    if (typeof event.reason !== "string" || event.reason.trim().length === 0) {
      throw refuse(
        `Tolling event "${event.code}" carries no reason. An adjustment nobody can explain is not one this platform will apply.`,
        { code: String(event.code) },
      );
    }
    if (typeof event.authority !== "string" || event.authority.trim().length === 0) {
      throw refuse(
        `Tolling event "${event.code}" names no authority. The instrument permitting the adjustment must be recorded.`,
        { code: String(event.code) },
      );
    }

    const effectiveAt = instantOf(event.effectiveAt, "effectiveAt", event.code);

    switch (event.kind) {
      case "suspend": {
        const endsAt = instantOf(event.endsAt, "endsAt", event.code);
        if (endsAt < effectiveAt) {
          throw refuse(
            `Tolling event "${event.code}" ends before it begins. An open-ended or reversed suspension would pause the clock indefinitely.`,
            { code: event.code },
          );
        }
        const firstDate = localDateAt(effectiveAt, timeZone);
        const lastDate = localDateAt(endsAt, timeZone);
        // Whole local days are excluded. Prorating a partial day would mean
        // inventing a rule about hours that no statute here states, and the
        // whole-day reading is the one that does not shorten the window.
        let cursor = firstDate;
        let dayCount = 0;
        while (compareCivilDates(cursor, lastDate) <= 0) {
          dayCount += 1;
          if (dayCount > MAX_TOLLING_DAYS) {
            throw refuse(
              `Tolling event "${event.code}" suspends the clock for more than ${MAX_TOLLING_DAYS} days. A suspension that long must be reviewed by a person.`,
              { code: event.code, limit: MAX_TOLLING_DAYS },
            );
          }
          suspendedDates.add(formatCivilDate(cursor));
          cursor = addDays(cursor, 1);
        }
        applied.push({
          kind: event.kind,
          code: event.code,
          reason: event.reason,
          authority: event.authority,
          recordedBy: event.recordedBy,
          effect: `Clock suspended for ${dayCount} local day(s), ${formatCivilDate(firstDate)} through ${formatCivilDate(lastDate)} in ${timeZone}; those days do not count toward the window.`,
        });
        break;
      }

      case "restart": {
        const newTrigger =
          event.newTriggerAt === undefined
            ? effectiveAt
            : instantOf(event.newTriggerAt, "newTriggerAt", event.code);
        if (newTrigger < triggerInstant) {
          throw refuse(
            `Tolling event "${event.code}" restarts the clock before the original trigger. A restart may only move the trigger later; moving it earlier would shorten the consumer's window.`,
            { code: event.code },
          );
        }
        // Latest restart wins: an earlier restart is superseded by a later one,
        // and the consumer keeps the longer window either way.
        if (restartAt === null || newTrigger > restartAt) restartAt = newTrigger;
        applied.push({
          kind: event.kind,
          code: event.code,
          reason: event.reason,
          authority: event.authority,
          recordedBy: event.recordedBy,
          effect: `Clock restarted from ${formatInstant(newTrigger)}; days counted before that instant are discarded.`,
        });
        break;
      }

      case "extend": {
        const days = event.extendByDays;
        if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
          throw refuse(
            `Tolling event "${event.code}" must extend the window by a positive whole number of days, received ${String(days)}.`,
            { code: event.code },
          );
        }
        if (days > MAX_TOLLING_DAYS) {
          throw refuse(
            `Tolling event "${event.code}" extends the window by ${days} days, past the ${MAX_TOLLING_DAYS}-day limit for a single event.`,
            { code: event.code, days, limit: MAX_TOLLING_DAYS },
          );
        }
        extraDays += days;
        if (extraDays > MAX_TOTAL_EXTENSION_DAYS) {
          throw refuse(
            `Tolling events extend the window by ${extraDays} days in total, past the ${MAX_TOTAL_EXTENSION_DAYS}-day limit. Stacking small extensions must not evade the per-event bound.`,
            { totalDays: extraDays, limit: MAX_TOTAL_EXTENSION_DAYS },
          );
        }
        applied.push({
          kind: event.kind,
          code: event.code,
          reason: event.reason,
          authority: event.authority,
          recordedBy: event.recordedBy,
          effect: `Window extended by ${days} day(s); the trigger is unchanged.`,
        });
        break;
      }

      default: {
        const unreachable: never = event.kind;
        throw refuse(`Unrecognised tolling kind "${String(unreachable)}".`, {});
      }
    }
  }

  if (restartAt !== null && suspendedDates.size > 0) {
    warnings.push(
      "Both a restart and a suspension were applied. Suspended days falling before the restart have no effect; confirm that is the intended reading.",
    );
  }

  return { restartAt, suspendedDates, extraDays, applied, warnings };
}
