import type { Clock } from "../kernel/clock.js";
import { DeniedError, InvalidInputError } from "../kernel/errors.js";
import { digestValue, type Digest } from "../kernel/hash.js";
import {
  HOLIDAY_CALENDARS,
  addDays,
  describeNonBusinessDay,
  formatCivilDate,
  formatInstant,
  formatOffset,
  holidayOn,
  instantFromZoned,
  isBusinessDay,
  isWeekend,
  localDateAt,
  offsetMsAt,
  parseIsoDate,
  parseIsoInstant,
  rollToBusinessDay,
  startOfLocalDay,
} from "./calendar.js";
import { DEFAULT_JURISDICTION, MAX_WINDOW_DAYS, RESCISSION_RULES } from "./rules.js";
import { planTolling } from "./tolling.js";
import type {
  CivilDate,
  DeadlineComputation,
  DerivationStep,
  HolidayCalendar,
  HolidayCalendarTable,
  IsoDate,
  JurisdictionEntry,
  JurisdictionTable,
  RescissionInput,
  RescissionRule,
  UncountedDay,
  Weekday,
} from "./types.js";

/**
 * Computing a statutory rescission deadline.
 *
 * One function, one answer, one derivation. Everything a reviewer needs to
 * agree or disagree with the result comes back attached to it: which rule
 * version governed, why that version and not another, where the clock started,
 * every day the count passed over and why it did not count, and what the
 * governing timezone's offset was at the moment the window closed.
 *
 * The refusals are the important part. This function will not produce a
 * deadline it cannot justify:
 *
 *   - a state with no rule on file          → refuse
 *   - a state whose rule does not cover the contract's date → refuse
 *   - two rule versions both covering it    → refuse (which law governs?)
 *   - a missing trigger input the rule needs → refuse
 *   - an unusable holiday calendar          → refuse
 *   - unverified rules, where the deployment forbids them → refuse
 *
 * Every one of those is `DeniedError`, and the caller must treat it as "no
 * deadline exists for this contract in this system" and route the contract to a
 * person. A guessed deadline is worse than no deadline: no deadline gets
 * escalated, a wrong one gets relied on.
 */

export interface ComputeOptions {
  /** Supplies `computedAt`. Injected so the demo and the tests are reproducible. */
  readonly clock: Clock;
  readonly rules?: JurisdictionTable | undefined;
  readonly holidayCalendars?: HolidayCalendarTable | undefined;
  /**
   * Refuse to compute from a rule nobody has verified.
   *
   * Shipped false so the engine can be exercised against the placeholder table.
   * A deployment that computes deadlines anyone acts on sets this true, at
   * which point the placeholders deny instead of answering.
   */
  readonly requireVerifiedRules?: boolean | undefined;
}

function refuse(message: string, detail: Record<string, string | number | boolean> = {}): DeniedError {
  return new DeniedError("knowledge.no_grounding", message, detail);
}

/**
 * Turn malformed rule data into a refusal rather than a validation error.
 *
 * A rule row with an impossible effective date or an unknown timezone is bad
 * data, not a bad request, but the caller must not be able to tell the
 * difference by catching a narrower error type and carrying on. `InvariantError`
 * is deliberately not converted: that means a bug in this module and should
 * page rather than be reported to the operator as "no deadline available".
 */
function denyingOnBadRuleData<T>(context: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof InvalidInputError) {
      throw refuse(`${context}: ${error.message}`, { field: error.field });
    }
    throw error;
  }
}

function optionalInstant(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return parseIsoInstant(value, field);
  } catch (error) {
    throw refuse(
      `${field} is not a usable instant: ${error instanceof InvalidInputError ? error.message : String(error)}`,
      { field },
    );
  }
}

/**
 * Does this rule version govern a contract formed at `instant`?
 *
 * Each version's effective period is interpreted in that version's own
 * timezone, which resolves what would otherwise be circular: the timezone is a
 * property of the rule, and the rule is what we are trying to select. Asking
 * each candidate the question in its own terms removes the circularity without
 * anybody having to nominate a "default" zone to break the tie in.
 */
function coversInstant(rule: RescissionRule, instant: number): boolean {
  const from = startOfLocalDay(parseIsoDate(rule.effectiveFrom, "effectiveFrom"), rule.timeZone);
  if (instant < from.instant) return false;
  if (rule.effectiveTo === null) return true;
  // `effectiveTo` names the last day the version governs, so the boundary is
  // the start of the following day.
  const endExclusive = startOfLocalDay(
    addDays(parseIsoDate(rule.effectiveTo, "effectiveTo"), 1),
    rule.timeZone,
  );
  return instant < endExclusive.instant;
}

interface WindowWalk {
  readonly deadline: CivilDate;
  readonly uncounted: readonly UncountedDay[];
  readonly truncated: boolean;
}

/** Most uncounted days recorded on a computation before the list is truncated. */
const MAX_RECORDED_UNCOUNTED_DAYS = 60;

/**
 * Walk forward from `start` until `window` days have counted.
 *
 * Counting is by civil date throughout. Nothing here touches an instant, which
 * is what keeps a window that spans a daylight-saving transition exactly as
 * many calendar days long as the statute says.
 */
function walkWindow(params: {
  readonly start: CivilDate;
  readonly window: number;
  readonly basis: RescissionRule["basis"];
  readonly calendar: HolidayCalendar;
  readonly weekendDays: readonly Weekday[];
  readonly suspended: ReadonlySet<IsoDate>;
}): WindowWalk {
  const uncounted: UncountedDay[] = [];
  let truncated = false;
  const note = (date: CivilDate, reason: string): void => {
    if (uncounted.length < MAX_RECORDED_UNCOUNTED_DAYS) {
      uncounted.push({ date: formatCivilDate(date), reason });
    } else {
      truncated = true;
    }
  };

  // Bounded so a holiday calendar that marks every day non-business, or a
  // suspension that swallows the whole window, fails fast instead of spinning
  // inside a request. The bound is generous enough that no legitimate window
  // reaches it.
  const maxSteps = MAX_WINDOW_DAYS * 3 + 400;

  let cursor = params.start;
  let counted = 0;
  let steps = 0;

  while (counted < params.window) {
    steps += 1;
    if (steps > maxSteps) {
      throw refuse(
        `Counting ${params.window} ${params.basis === "business_days" ? "business" : "calendar"} days from ${formatCivilDate(params.start)} did not terminate within ${maxSteps} days. The holiday calendar or the tolling suspensions make the window uncountable.`,
        { window: params.window, start: formatCivilDate(params.start) },
      );
    }

    const iso = formatCivilDate(cursor);
    if (params.suspended.has(iso)) {
      note(cursor, "clock suspended by a tolling event");
    } else if (params.basis === "business_days" && !isBusinessDay(cursor, params.calendar, params.weekendDays)) {
      note(cursor, describeNonBusinessDay(cursor, params.calendar));
    } else {
      counted += 1;
      if (counted === params.window) break;
    }
    cursor = addDays(cursor, 1);
  }

  return { deadline: cursor, uncounted, truncated };
}

/**
 * Compute the rescission deadline for a contract.
 *
 * @returns the full derivation, not merely the instant.
 * @throws {DeniedError} `knowledge.no_grounding` when no deadline can be
 *   justified, and `knowledge.stale_authority` when the governing rule is
 *   unverified and the deployment forbids that.
 */
export function computeRescissionDeadline(
  input: RescissionInput,
  options: ComputeOptions,
): DeadlineComputation {
  const table = options.rules ?? RESCISSION_RULES;
  const calendars = options.holidayCalendars ?? HOLIDAY_CALENDARS;

  const steps: DerivationStep[] = [];
  const warnings: string[] = [];
  const step = (label: string, detail: string): void => {
    steps.push({ index: steps.length + 1, label, detail });
  };

  // --- jurisdiction -------------------------------------------------------

  const rawState = typeof input.stateCode === "string" ? input.stateCode.trim().toUpperCase() : "";
  if (rawState.length === 0) {
    throw refuse(
      "No jurisdiction was supplied. A rescission period is a creature of state law; without a state there is nothing to compute.",
    );
  }
  if (!/^[A-Z]{2,10}$/.test(rawState)) {
    throw refuse(`"${rawState}" is not a jurisdiction code this platform recognises.`, {
      stateCode: rawState,
    });
  }

  // `table` is a Map rather than a plain object so a key like `constructor`
  // cannot reach a prototype member and be mistaken for a jurisdiction entry.
  const found = table.get(rawState);
  const entry: JurisdictionEntry = found ?? DEFAULT_JURISDICTION;
  if (!found) {
    step(
      "jurisdiction.fallback",
      `No rule table entry for "${rawState}"; fell back to the DEFAULT entry, which carries no rules and therefore refuses.`,
    );
  } else {
    step("jurisdiction.resolved", `Jurisdiction ${rawState} (${entry.label}) resolved from the rule table.`);
  }

  // --- the instant that fixes which law governs ---------------------------

  const executedAt = optionalInstant(input.contractExecutedAt, "contractExecutedAt");
  const deliveredAt = optionalInstant(input.documentsDeliveredAt, "documentsDeliveredAt");

  // Which version of the law governs is fixed when the contract is formed;
  // which event starts the clock is a separate question the selected version
  // answers. Conflating the two is how an amended statute gets applied
  // retroactively to a contract it never governed.
  const governingInstant = executedAt ?? deliveredAt;
  if (governingInstant === undefined) {
    throw refuse(
      "Neither a contract execution instant nor a document delivery instant was supplied, so there is no date from which to select the governing rule.",
      { stateCode: rawState },
    );
  }
  step(
    "governing_date.resolved",
    `Governing law fixed at ${formatInstant(governingInstant)}, taken from ${executedAt !== undefined ? "contract execution" : "document delivery"}.`,
  );

  // --- rule version -------------------------------------------------------

  if (entry.versions.length === 0) {
    throw refuse(
      `No rescission rule is on file for "${rawState}". The platform refuses to infer a window from a neighbouring state or from a default: a guessed window either rejects a timely cancellation or accepts a late one, and both are the company's problem.`,
      { stateCode: rawState },
    );
  }

  const applicable = denyingOnBadRuleData(
    `Selecting the ${rawState} rule version failed on unusable rule data`,
    () => entry.versions.filter((rule) => coversInstant(rule, governingInstant)),
  );
  if (applicable.length === 0) {
    const ranges = entry.versions
      .map((rule) => `${rule.version} (${rule.effectiveFrom} to ${rule.effectiveTo ?? "current"})`)
      .join(", ");
    throw refuse(
      `No ${rawState} rule version was in effect at ${formatInstant(governingInstant)}. Versions on file: ${ranges}.`,
      { stateCode: rawState, governingInstant: formatInstant(governingInstant) },
    );
  }
  if (applicable.length > 1) {
    throw refuse(
      `${applicable.length} ${rawState} rule versions cover ${formatInstant(governingInstant)} (${applicable.map((rule) => rule.version).join(", ")}). Overlapping effective periods make the governing law ambiguous, so the computation is refused rather than resolved arbitrarily.`,
      { stateCode: rawState, versions: applicable.map((rule) => rule.version).join(",") },
    );
  }

  const rule = applicable[0];
  if (!rule) throw refuse("Rule selection produced no rule.", { stateCode: rawState });

  step(
    "rule.selected",
    `Rule version ${rule.version} governs, effective ${rule.effectiveFrom} to ${rule.effectiveTo ?? "current"}. Citation: ${rule.citation}`,
  );

  if (!rule.verified) {
    if (options.requireVerifiedRules === true) {
      throw new DeniedError(
        "knowledge.stale_authority",
        `Rule version ${rule.version} for ${rawState} has not been verified against current law, and this deployment refuses to compute statutory deadlines from unverified rules.`,
        { stateCode: rawState, version: rule.version },
      );
    }
    warnings.push(
      `Rule version ${rule.version} is UNVERIFIED placeholder data. This deadline must not be relied on. ${rule.reviewRequired}`,
    );
  }
  if (rule.timeZoneNote) warnings.push(`Timezone caveat for ${rawState}: ${rule.timeZoneNote}`);

  const calendar = calendars.get(rule.holidayCalendarId);
  if (!calendar) {
    // Treating a missing calendar as "no holidays" would silently shorten every
    // business-day window in the jurisdiction.
    throw refuse(
      `Holiday calendar "${rule.holidayCalendarId}" required by ${rule.version} is not loaded. Counting without it would silently treat holidays as ordinary business days.`,
      { stateCode: rawState, calendarId: rule.holidayCalendarId },
    );
  }
  if (!calendar.verified) {
    warnings.push(
      `Holiday calendar ${calendar.id} is UNVERIFIED placeholder data. ${calendar.reviewRequired}`,
    );
  }

  // --- trigger ------------------------------------------------------------

  let baseTrigger: number;
  switch (rule.trigger) {
    case "contract_execution":
      if (executedAt === undefined) {
        throw refuse(
          `${rawState} counts from execution of the purchase contract, and no contract execution instant was supplied.`,
          { stateCode: rawState, required: "contractExecutedAt" },
        );
      }
      baseTrigger = executedAt;
      step("trigger.resolved", `Clock starts from contract execution at ${formatInstant(baseTrigger)}.`);
      break;
    case "document_delivery":
      if (deliveredAt === undefined) {
        throw refuse(
          `${rawState} counts from delivery of the disclosure documents, and no delivery instant was supplied.`,
          { stateCode: rawState, required: "documentsDeliveredAt" },
        );
      }
      baseTrigger = deliveredAt;
      step("trigger.resolved", `Clock starts from document delivery at ${formatInstant(baseTrigger)}.`);
      break;
    case "later_of_execution_or_delivery": {
      if (executedAt === undefined || deliveredAt === undefined) {
        const missing = executedAt === undefined ? "contractExecutedAt" : "documentsDeliveredAt";
        throw refuse(
          `${rawState} counts from the later of contract execution and document delivery, and ${missing} was not supplied. Falling back to the one instant that is present would start the clock too early whenever delivery came second.`,
          { stateCode: rawState, required: missing },
        );
      }
      baseTrigger = Math.max(executedAt, deliveredAt);
      step(
        "trigger.resolved",
        `Clock starts from the later of execution (${formatInstant(executedAt)}) and delivery (${formatInstant(deliveredAt)}): ${formatInstant(baseTrigger)}.`,
      );
      break;
    }
    default: {
      const unreachable: never = rule.trigger;
      throw refuse(`Unrecognised trigger event "${String(unreachable)}".`, { stateCode: rawState });
    }
  }

  // --- tolling ------------------------------------------------------------

  const tolling = planTolling(input.tollingEvents ?? [], rule.timeZone, baseTrigger);
  warnings.push(...tolling.warnings);

  const triggerInstant = tolling.restartAt ?? baseTrigger;
  if (tolling.restartAt !== null) {
    step("tolling.restart", `Clock restarted; the effective trigger is ${formatInstant(triggerInstant)}.`);
  }

  const windowApplied = rule.windowLength + tolling.extraDays;
  if (tolling.extraDays > 0) {
    step(
      "tolling.extension",
      `Window extended from ${rule.windowLength} to ${windowApplied} ${rule.basis === "business_days" ? "business" : "calendar"} days by tolling.`,
    );
  }
  if (windowApplied > MAX_WINDOW_DAYS) {
    throw refuse(
      `The window after tolling is ${windowApplied} days, past the ${MAX_WINDOW_DAYS}-day sanity bound.`,
      { windowApplied, limit: MAX_WINDOW_DAYS },
    );
  }
  if (!Number.isInteger(rule.windowLength) || rule.windowLength < 1) {
    throw refuse(
      `Rule ${rule.version} states a window of ${rule.windowLength}, which is not a positive whole number of days.`,
      { version: rule.version },
    );
  }

  // --- counting -----------------------------------------------------------

  const triggerLocalDate: CivilDate = denyingOnBadRuleData(
    `The governing timezone "${rule.timeZone}" for ${rule.version} could not be resolved`,
    () => localDateAt(triggerInstant, rule.timeZone),
  );

  const countingStartDate =
    rule.countingStart === "day_after_trigger" ? addDays(triggerLocalDate, 1) : triggerLocalDate;
  step(
    "counting.start",
    `Trigger falls on ${formatCivilDate(triggerLocalDate)} local time in ${rule.timeZone}; counting starts ${rule.countingStart === "day_after_trigger" ? "the following day" : "on the trigger day itself"}, ${formatCivilDate(countingStartDate)}.`,
  );

  const walk = denyingOnBadRuleData(
    `Counting the ${rawState} window failed on unusable calendar data`,
    () =>
      walkWindow({
        start: countingStartDate,
        window: windowApplied,
        basis: rule.basis,
        calendar,
        weekendDays: rule.weekendDays,
        suspended: tolling.suspendedDates,
      }),
  );
  if (walk.truncated) {
    warnings.push(
      `More than ${MAX_RECORDED_UNCOUNTED_DAYS} uncounted days were passed over; the recorded list is truncated.`,
    );
  }

  const rawDeadlineDate = walk.deadline;
  step(
    "counting.completed",
    `Counted ${windowApplied} ${rule.basis === "business_days" ? "business" : "calendar"} day(s), passing over ${walk.uncounted.length} day(s) that did not count; the count lands on ${formatCivilDate(rawDeadlineDate)}.`,
  );

  // --- weekend and holiday roll -------------------------------------------

  const uncounted: UncountedDay[] = [...walk.uncounted];
  let deadlineDate = rawDeadlineDate;

  if (rule.roll === "next_business_day") {
    const rolled = denyingOnBadRuleData(
      `Rolling ${formatCivilDate(rawDeadlineDate)} forward to a business day failed`,
      () => rollToBusinessDay(rawDeadlineDate, calendar, rule.weekendDays),
    );
    deadlineDate = rolled.date;
    for (const skipped of rolled.skipped) {
      uncounted.push({ date: skipped.date, reason: `${skipped.reason} — deadline rolled forward` });
    }
    step(
      "roll.applied",
      rolled.skipped.length === 0
        ? `${formatCivilDate(rawDeadlineDate)} is already a business day; no roll needed.`
        : `${formatCivilDate(rawDeadlineDate)} is not a business day (${rolled.skipped.map((s) => s.reason).join("; ")}); the deadline rolls forward to ${formatCivilDate(deadlineDate)}.`,
    );
  } else {
    const holiday = holidayOn(rawDeadlineDate, calendar);
    const weekend = isWeekend(rawDeadlineDate, rule.weekendDays);
    step(
      "roll.not_applied",
      weekend || holiday
        ? `${formatCivilDate(rawDeadlineDate)} is a non-business day (${holiday ?? "weekend"}), but ${rule.version} does not roll the deadline forward, so it stands.`
        : `${rule.version} does not roll the deadline; ${formatCivilDate(rawDeadlineDate)} stands.`,
    );
  }

  // --- close of the window as an absolute instant -------------------------

  const endOfDay = rule.endOfDay;
  const zoned = denyingOnBadRuleData(
    `Resolving the close of the ${rawState} window to an instant failed`,
    () =>
      instantFromZoned(
        {
          ...deadlineDate,
          hour: endOfDay.hour,
          minute: endOfDay.minute,
          second: endOfDay.second,
          millisecond: endOfDay.millisecond,
        },
        rule.timeZone,
      ),
  );
  if (zoned.resolution !== "unique") {
    warnings.push(
      zoned.resolution === "nonexistent_shifted"
        ? `The deadline's local wall-clock time does not exist on ${formatCivilDate(deadlineDate)} in ${rule.timeZone} because the clocks moved forward; it was resolved to the first instant after the gap, which favours the consumer.`
        : `The deadline's local wall-clock time occurs twice on ${formatCivilDate(deadlineDate)} in ${rule.timeZone} because the clocks moved back; the later occurrence was used, which favours the consumer.`,
    );
  }

  const offset = offsetMsAt(zoned.instant, rule.timeZone);
  const deadlineLocalTime = `${String(endOfDay.hour).padStart(2, "0")}:${String(endOfDay.minute).padStart(2, "0")}:${String(endOfDay.second).padStart(2, "0")}.${String(endOfDay.millisecond).padStart(3, "0")}`;

  step(
    "deadline.resolved",
    `The window closes at ${deadlineLocalTime} local on ${formatCivilDate(deadlineDate)} in ${rule.timeZone} (UTC${formatOffset(offset)}), which is ${formatInstant(zoned.instant)}.`,
  );

  if (zoned.instant <= triggerInstant) {
    // Belt and braces: a rule or a tolling event that produced a deadline at or
    // before the trigger would be a nonsense the caller must not act on.
    throw refuse(
      `The computed deadline ${formatInstant(zoned.instant)} is not after the trigger ${formatInstant(triggerInstant)}.`,
      { stateCode: rawState, version: rule.version },
    );
  }

  return {
    jurisdiction: rawState,
    jurisdictionLabel: entry.label,
    rule,
    ruleVersion: rule.version,
    citation: rule.citation,
    sourceUrl: rule.sourceUrl,
    ruleVerified: rule.verified,
    timeZone: rule.timeZone,
    trigger: rule.trigger,
    triggerInstant: formatInstant(triggerInstant),
    triggerLocalDate: formatCivilDate(triggerLocalDate),
    countingStartDate: formatCivilDate(countingStartDate),
    basis: rule.basis,
    windowLength: rule.windowLength,
    windowApplied,
    uncountedDays: uncounted,
    rawDeadlineDate: formatCivilDate(rawDeadlineDate),
    deadlineLocalDate: formatCivilDate(deadlineDate),
    deadlineLocalTime,
    deadlineInstant: formatInstant(zoned.instant),
    utcOffsetAtDeadline: formatOffset(offset),
    zoneResolution: zoned.resolution,
    tollingApplied: tolling.applied,
    steps,
    warnings,
    computedAt: options.clock.nowIso(),
  };
}

/**
 * Fingerprint of a computation, for the audit record.
 *
 * The audit log stores fingerprints, never payloads, so this covers the facts
 * that determine the answer — jurisdiction, rule version, citation, trigger,
 * and the resulting deadline — and deliberately excludes `computedAt` and the
 * prose of the derivation. Re-deriving the same contract under the same rule
 * must produce the same fingerprint however many times it is asked, or the
 * audit trail records churn rather than change.
 */
export function deadlineFingerprint(computation: DeadlineComputation): Digest {
  return digestValue({
    jurisdiction: computation.jurisdiction,
    ruleVersion: computation.ruleVersion,
    citation: computation.citation,
    ruleVerified: computation.ruleVerified,
    trigger: computation.trigger,
    triggerInstant: computation.triggerInstant,
    basis: computation.basis,
    windowApplied: computation.windowApplied,
    timeZone: computation.timeZone,
    deadlineLocalDate: computation.deadlineLocalDate,
    deadlineInstant: computation.deadlineInstant,
  });
}

/**
 * Whether a cancellation received at `receivedAt` was within the window.
 *
 * Comparison is on instants, which is the one place instants are the right
 * unit: "did this arrive before the window closed" is a question about
 * moments, not about calendar days.
 */
export function isWithinRescissionWindow(
  computation: DeadlineComputation,
  receivedAt: string,
): boolean {
  const received = parseIsoInstant(receivedAt, "receivedAt");
  return received <= parseIsoInstant(computation.deadlineInstant, "deadlineInstant");
}
