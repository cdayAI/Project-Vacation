/**
 * Statutory clocks: the domain types.
 *
 * A vacation-ownership purchase carries a state-law rescission period — a
 * window during which the buyer may cancel. Miss it and the contract is
 * voidable; compute it a day short and the company rejects a timely
 * cancellation, which is the expensive direction of the error. So the brief is
 * explicit: never compute a legal deadline with naive date arithmetic, and
 * centralise it in one tested module with per-state rules as data.
 *
 * Three conventions run through every type here.
 *
 * Timestamps are strings, never `Date`. `IsoInstant` is an absolute moment
 * (`2026-08-06T13:05:00.000Z`); `IsoDate` is a civil calendar date with no
 * timezone at all (`2026-08-06`). Keeping them in separate types is not
 * decoration — half of the ways a deadline goes wrong come from treating a
 * civil date as though it were an instant, or vice versa. A rule's
 * `effectiveFrom` is a civil date because a statute takes effect on a date, not
 * at a UTC moment; a contract's execution is an instant because it happened at
 * a moment.
 *
 * Every rule is versioned and effective-dated, because the question a
 * compliance reviewer actually asks is "what did the rule say on the date of
 * *that* contract", not "what does it say today".
 *
 * Every rule carries its own provenance — citation, source URL, and a
 * `verified` flag. An unverified rule is allowed to exist so the engine can be
 * exercised, but it is never allowed to look verified, and a deployment can
 * refuse to compute from unverified rules entirely.
 */

/** A civil calendar date, `YYYY-MM-DD`. No timezone, no time of day. */
export type IsoDate = string;

/** An absolute moment as an ISO-8601 string, normalised to UTC. */
export type IsoInstant = string;

/** 0 = Sunday through 6 = Saturday, matching the conventional index. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY_NAMES: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** A date on the proleptic Gregorian calendar. `month` is 1-12, `day` is 1-31. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface CivilTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

export interface CivilDateTime extends CivilDate, CivilTime {}

/**
 * How a local wall-clock time was mapped onto an absolute instant.
 *
 * Twice a year a local time is either ambiguous (it happens twice) or
 * non-existent (it is skipped). A deadline that silently picks one without
 * saying so is a deadline nobody can defend later, so the choice is recorded
 * on the computation.
 */
export type ZonedResolution = "unique" | "ambiguous_later" | "nonexistent_shifted";

/** Whether the window is counted in calendar days or business days. */
export type DayCountBasis = "calendar_days" | "business_days";

/**
 * What starts the clock.
 *
 * Some states count from execution of the purchase contract. Some count from
 * delivery of the public offering statement or the disclosure documents. Some
 * count from whichever of the two happened later, which is the case that
 * punishes naive implementations: they take the execution date because it is
 * the one that is always populated.
 */
export type TriggerEvent =
  | "contract_execution"
  | "document_delivery"
  | "later_of_execution_or_delivery";

/** Whether the trigger day itself is counted, or counting starts the next day. */
export type CountingStart = "trigger_day" | "day_after_trigger";

/**
 * What happens when the computed deadline lands on a non-business day.
 *
 * `next_business_day` extends to the following business day. `none` leaves the
 * deadline where it falls. Which one applies is a question of state law, so it
 * is data on the rule rather than a global behaviour.
 */
export type WeekendRollRule = "none" | "next_business_day";

/** The local wall-clock moment at which the window closes on its final day. */
export interface LocalDeadlineTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/**
 * A holiday, expressed as a rule rather than a list of dates.
 *
 * Dates go stale; rules do not. `explicit_dates` exists for holidays that
 * genuinely have no closed form (anything tied to a lunar or ecclesiastical
 * calendar, or a one-off proclamation) and it is deliberately awkward to use
 * so that it stays the exception.
 */
export type HolidayDefinition =
  | {
      readonly kind: "fixed_date";
      readonly month: number;
      readonly day: number;
      /** Whether a weekend occurrence is observed on the adjacent weekday. */
      readonly observance: "none" | "nearest_weekday";
    }
  | {
      readonly kind: "nth_weekday";
      readonly month: number;
      readonly weekday: Weekday;
      /** 1 = first occurrence in the month, 2 = second, and so on. */
      readonly nth: 1 | 2 | 3 | 4 | 5;
    }
  | {
      readonly kind: "last_weekday";
      readonly month: number;
      readonly weekday: Weekday;
    }
  | {
      readonly kind: "explicit_dates";
      readonly dates: readonly IsoDate[];
    };

export interface Holiday {
  /** Stable machine name, e.g. `us.independence_day`. */
  readonly id: string;
  readonly name: string;
  readonly definition: HolidayDefinition;
  /** False until someone has checked this against the jurisdiction's own list. */
  readonly verified: boolean;
}

export interface HolidayCalendar {
  /** Stable id referenced by `RescissionRule.holidayCalendarId`. */
  readonly id: string;
  readonly label: string;
  readonly holidays: readonly Holiday[];
  readonly verified: boolean;
  /** What a reviewer must confirm before this calendar is trusted. */
  readonly reviewRequired: string;
}

/**
 * One effective-dated version of one state's rescission rule.
 *
 * Everything that varies between states lives here as data. Nothing about a
 * particular state may appear as a branch in the computation, because a branch
 * cannot be diffed, reviewed by counsel, or effective-dated.
 */
export interface RescissionRule {
  /** Two-letter state code, or `DEFAULT` for the refusing fallback. */
  readonly jurisdiction: string;
  /** Stable identifier for this version, e.g. `FL@2`. Appears in the audit record. */
  readonly version: string;
  /** Length of the window in whichever unit `basis` names. */
  readonly windowLength: number;
  readonly basis: DayCountBasis;
  readonly trigger: TriggerEvent;
  readonly countingStart: CountingStart;
  readonly roll: WeekendRollRule;
  /** Days treated as non-business days every week. Data, because it is not universal. */
  readonly weekendDays: readonly Weekday[];
  readonly holidayCalendarId: string;
  readonly endOfDay: LocalDeadlineTime;
  /** IANA zone the clock runs in, e.g. `America/New_York`. Never a fixed offset. */
  readonly timeZone: string;
  /** Set where the state spans more than one zone and the choice is a simplification. */
  readonly timeZoneNote?: string | undefined;
  readonly effectiveFrom: IsoDate;
  /** Inclusive last date this version governs; `null` means "still current". */
  readonly effectiveTo: IsoDate | null;
  readonly citation: string;
  readonly sourceUrl: string;
  /** True only once a human has checked the citation. See rules.ts. */
  readonly verified: boolean;
  readonly reviewRequired: string;
}

/**
 * All versions of one jurisdiction's rule.
 *
 * A jurisdiction with an empty `versions` array refuses every computation.
 * That is how the `DEFAULT` fallback is expressed: as data with no rule in it,
 * so refusal travels the same code path as "no version covers this contract"
 * rather than needing a second branch somebody could forget to write.
 */
export interface JurisdictionEntry {
  readonly jurisdiction: string;
  readonly label: string;
  readonly versions: readonly RescissionRule[];
}

export type JurisdictionTable = ReadonlyMap<string, JurisdictionEntry>;
export type HolidayCalendarTable = ReadonlyMap<string, HolidayCalendar>;

/** Why a clock was paused, restarted, or extended. */
export type TollingCode =
  | "documents_redelivered"
  | "disclosure_defect_cured"
  | "consumer_incapacity"
  | "emergency_declaration"
  | "regulator_directive"
  | "agreed_extension";

export type TollingKind = "suspend" | "restart" | "extend";

/**
 * An event that pauses, restarts, or lengthens the clock.
 *
 * Tolling is where deadlines are most often got wrong in practice, because it
 * is the part that is handled by hand. Each event therefore carries the reason
 * a person gave, the instrument that authorises it, and who recorded it — the
 * three things a reviewer asks for when a deadline turns out to be longer than
 * the statute's face value.
 */
export interface TollingEvent {
  readonly kind: TollingKind;
  readonly code: TollingCode;
  /** Why, in a sentence a reviewer can read. Not owner personal data. */
  readonly reason: string;
  /** The statute, order, or signed instrument relied on. */
  readonly authority: string;
  /** Actor id of whoever recorded the event. Never a name. */
  readonly recordedBy: string;
  /** When the event takes effect. */
  readonly effectiveAt: IsoInstant;
  /** `suspend` only: when the pause lifts. Required — an open-ended pause is refused. */
  readonly endsAt?: IsoInstant | undefined;
  /** `restart` only: the new trigger instant. Defaults to `effectiveAt`. */
  readonly newTriggerAt?: IsoInstant | undefined;
  /** `extend` only: whole days added to the window. */
  readonly extendByDays?: number | undefined;
}

/** A tolling event as it actually bore on this computation. */
export interface AppliedTolling {
  readonly kind: TollingKind;
  readonly code: TollingCode;
  readonly reason: string;
  readonly authority: string;
  readonly recordedBy: string;
  /** Human-readable statement of what this event did to the clock. */
  readonly effect: string;
}

/** A day the window passed over, and why it did not count. */
export interface UncountedDay {
  readonly date: IsoDate;
  readonly reason: string;
}

/** One line of the derivation, in the order it was performed. */
export interface DerivationStep {
  /** 1-based position in the derivation. */
  readonly index: number;
  /** Stable machine label, e.g. `rule.selected`. */
  readonly label: string;
  /** The step in plain language, for a reviewer who is not reading this code. */
  readonly detail: string;
}

/** What the caller knows about the contract. */
export interface RescissionInput {
  /** Two-letter state code governing the contract. */
  readonly stateCode: string;
  readonly contractExecutedAt?: IsoInstant | undefined;
  readonly documentsDeliveredAt?: IsoInstant | undefined;
  readonly tollingEvents?: readonly TollingEvent[] | undefined;
}

/**
 * The full auditable derivation of one deadline.
 *
 * This is the artifact, not the instant. A bare timestamp cannot be reviewed,
 * challenged, or re-derived two years later when the statute has changed; the
 * derivation can.
 */
export interface DeadlineComputation {
  readonly jurisdiction: string;
  readonly jurisdictionLabel: string;
  readonly rule: RescissionRule;
  readonly ruleVersion: string;
  readonly citation: string;
  readonly sourceUrl: string;
  readonly ruleVerified: boolean;

  readonly timeZone: string;
  readonly trigger: TriggerEvent;
  readonly triggerInstant: IsoInstant;
  readonly triggerLocalDate: IsoDate;
  readonly countingStartDate: IsoDate;

  readonly basis: DayCountBasis;
  /** The window as the rule states it. */
  readonly windowLength: number;
  /** The window after any tolling extension. */
  readonly windowApplied: number;
  readonly uncountedDays: readonly UncountedDay[];

  /** Where the count landed, before any weekend or holiday roll. */
  readonly rawDeadlineDate: IsoDate;
  readonly deadlineLocalDate: IsoDate;
  /** Local wall-clock time the window closes, `HH:MM:SS.mmm`. */
  readonly deadlineLocalTime: string;
  readonly deadlineInstant: IsoInstant;
  /** UTC offset in force at the deadline, e.g. `-04:00`. Proves DST was applied. */
  readonly utcOffsetAtDeadline: string;
  readonly zoneResolution: ZonedResolution;

  readonly tollingApplied: readonly AppliedTolling[];
  readonly steps: readonly DerivationStep[];
  /** Anything a reviewer must know that did not stop the computation. */
  readonly warnings: readonly string[];
  readonly computedAt: IsoInstant;
}
