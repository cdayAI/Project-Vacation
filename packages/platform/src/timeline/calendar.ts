import { InvalidInputError, InvariantError } from "../kernel/errors.js";
import { WEEKDAY_NAMES } from "./types.js";
import type {
  CivilDate,
  CivilDateTime,
  Holiday,
  HolidayCalendar,
  HolidayCalendarTable,
  IsoDate,
  IsoInstant,
  Weekday,
  ZonedResolution,
} from "./types.js";

/**
 * Calendar arithmetic for legal deadlines.
 *
 * The failure this file exists to prevent is the one that looks like it works:
 * `new Date(signedAt.getTime() + 10 * 86_400_000)`. That is wrong twice over.
 * It is wrong on the two days a year a local day is 23 or 25 hours long, and it
 * is wrong every day of the year in a state that counts business days. The
 * second error is obvious in testing; the first is not, which is why it ships.
 *
 * The fix is to stop doing arithmetic on instants and start doing it on civil
 * dates. A statute that says "ten days" means ten entries on a wall calendar in
 * the governing jurisdiction — a count of civil days, not an elapsed duration.
 * So the pipeline is always:
 *
 *   instant --(IANA timezone)--> civil date
 *           --(integer day arithmetic)--> civil date
 *           --(IANA timezone)--> instant
 *
 * Only the first and last conversions know about timezones, and both go through
 * `Intl.DateTimeFormat` with a named IANA zone. There is no offset table in
 * this file and there must never be one: an offset hard-coded as -5 is a bug
 * that surfaces on the second Sunday in March.
 *
 * A consequence worth stating because it looks like a defect: a three-day
 * window that spans a spring-forward transition is 71 real hours, and one that
 * spans fall-back is 73. That is correct. The wall clock advanced three days;
 * the sun did not. What must never happen is the reverse — 72 fixed hours
 * producing a deadline at 22:59 or 00:59 local instead of the intended midnight
 * — because that either rejects a timely rescission or accepts a late one.
 */

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;

/** Epoch day 0 is 1970-01-01, a Thursday. Used to derive the day of week. */
const EPOCH_DAY_OF_WEEK = 4;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// Civil date arithmetic. No timezone, no Date object, no ambiguity.
// ---------------------------------------------------------------------------

/**
 * Days since 1970-01-01 for a proleptic Gregorian date.
 *
 * Hinnant's `days_from_civil`. Chosen over `Date.UTC` because `Date.UTC`
 * silently maps two-digit years into the 1900s and accepts out-of-range
 * components by rolling them over, both of which turn a malformed rule into a
 * plausible-looking wrong answer instead of an error.
 */
export function daysFromCivil(date: CivilDate): number {
  const { month, day } = date;
  const year = date.year - (month <= 2 ? 1 : 0);
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400; // [0, 399]
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // [0, 365]
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** Inverse of {@link daysFromCivil}. */
export function civilFromDays(days: number): CivilDate {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097; // [0, 146096]
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) /
      365,
  ); // [0, 399]
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100)); // [0, 365]
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153); // [0, 11]
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1; // [1, 31]
  const month = monthPrime + (monthPrime < 10 ? 3 : -9); // [1, 12]
  return { year: year + (month <= 2 ? 1 : 0), month, day };
}

/** Add (or subtract) whole calendar days. Pure integer arithmetic. */
export function addDays(date: CivilDate, days: number): CivilDate {
  if (!Number.isInteger(days)) {
    throw new InvalidInputError(`Calendar days must be a whole number, received ${days}`, "days");
  }
  return civilFromDays(daysFromCivil(date) + days);
}

/** 0 = Sunday through 6 = Saturday. */
export function dayOfWeek(date: CivilDate): Weekday {
  const days = daysFromCivil(date);
  return ((((days + EPOCH_DAY_OF_WEEK) % 7) + 7) % 7) as Weekday;
}

function pad(value: number, width: number): string {
  return String(Math.abs(value)).padStart(width, "0");
}

export function formatCivilDate(date: CivilDate): IsoDate {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/**
 * Parse a `YYYY-MM-DD` civil date.
 *
 * Strict on purpose. `2026-02-30` round-trips to `2026-03-02` under permissive
 * parsing, which would make a typo in a rule table silently shift an effective
 * date by two days, so the round-trip is checked rather than assumed.
 */
export function parseIsoDate(value: string, field = "date"): CivilDate {
  if (typeof value !== "string") {
    throw new InvalidInputError(`Expected an ISO date string for ${field}`, field);
  }
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    throw new InvalidInputError(`"${value}" is not a YYYY-MM-DD date (${field})`, field);
  }
  const [, y, m, d] = match;
  const date: CivilDate = { year: Number(y), month: Number(m), day: Number(d) };
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) {
    throw new InvalidInputError(`"${value}" has an out-of-range component (${field})`, field);
  }
  if (formatCivilDate(civilFromDays(daysFromCivil(date))) !== value) {
    throw new InvalidInputError(`"${value}" is not a real calendar date (${field})`, field);
  }
  return date;
}

/** Compare two civil dates: negative if `a` is earlier. */
export function compareCivilDates(a: CivilDate, b: CivilDate): number {
  return daysFromCivil(a) - daysFromCivil(b);
}

// ---------------------------------------------------------------------------
// Instants.
// ---------------------------------------------------------------------------

/**
 * Parse an ISO-8601 instant, with or without an explicit offset.
 *
 * A contract execution timestamp may arrive carrying the offset of the sales
 * gallery that produced it. That is fine — an offset is unambiguous. What is
 * refused is a bare local timestamp with no zone at all, because interpreting
 * it would mean guessing, and guessing is the thing this module exists to stop.
 */
export function parseIsoInstant(value: string, field = "instant"): number {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidInputError(`Expected an ISO-8601 instant for ${field}`, field);
  }
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match) {
    throw new InvalidInputError(
      `"${value}" is not an ISO-8601 instant with a UTC designator or offset (${field})`,
      field,
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidInputError(`"${value}" could not be parsed as an instant (${field})`, field);
  }
  return parsed;
}

/** Render an instant as an ISO-8601 UTC string. */
export function formatInstant(instant: number): IsoInstant {
  if (!Number.isFinite(instant)) {
    throw new InvariantError(`Cannot format a non-finite instant: ${String(instant)}`);
  }
  // An explicit instant, not a wall-clock reading: the clock injection rule is
  // about where "now" comes from, and nothing here reads "now".
  return new Date(instant).toISOString();
}

function msFromCivilDateTime(dt: CivilDateTime): number {
  return (
    daysFromCivil(dt) * MS_PER_DAY +
    dt.hour * MS_PER_HOUR +
    dt.minute * MS_PER_MINUTE +
    dt.second * MS_PER_SECOND +
    dt.millisecond
  );
}

// ---------------------------------------------------------------------------
// Timezone conversion, via Intl only.
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new InvalidInputError(
      `"${timeZone}" is not an IANA timezone this runtime recognises. A rule must name a zone, never a fixed offset.`,
      "timeZone",
    );
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** True if the runtime can resolve this IANA zone. */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The local wall-clock fields in `timeZone` at `instant`. */
export function zonedFieldsAt(instant: number, timeZone: string): CivilDateTime {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const read = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) {
      throw new InvariantError(`Intl did not return a "${type}" part for zone ${timeZone}`);
    }
    const value = Number(part.value);
    if (!Number.isFinite(value)) {
      throw new InvariantError(`Intl returned a non-numeric "${type}" part: ${part.value}`);
    }
    return value;
  };
  const hour = read("hour");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // Some engines render midnight as hour 24 even under h23; normalise so the
    // value can never be fed back as an out-of-range hour.
    hour: hour === 24 ? 0 : hour,
    minute: read("minute"),
    second: read("second"),
    // Intl has second granularity, so milliseconds come from the instant itself.
    millisecond: ((instant % MS_PER_SECOND) + MS_PER_SECOND) % MS_PER_SECOND,
  };
}

/**
 * UTC offset in milliseconds in force in `timeZone` at `instant`.
 *
 * Derived by asking Intl what the wall clock reads and subtracting: the
 * difference between "these wall fields read as if they were UTC" and the
 * instant is exactly the offset.
 */
export function offsetMsAt(instant: number, timeZone: string): number {
  return msFromCivilDateTime(zonedFieldsAt(instant, timeZone)) - instant;
}

/** Render an offset as `+HH:MM` / `-HH:MM`. */
export function formatOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? "-" : "+";
  const total = Math.round(Math.abs(offsetMs) / MS_PER_MINUTE);
  return `${sign}${pad(Math.floor(total / 60), 2)}:${pad(total % 60, 2)}`;
}

/** The civil date in `timeZone` at `instant`. */
export function localDateAt(instant: number, timeZone: string): CivilDate {
  const fields = zonedFieldsAt(instant, timeZone);
  return { year: fields.year, month: fields.month, day: fields.day };
}

export interface ZonedInstant {
  readonly instant: number;
  readonly resolution: ZonedResolution;
}

/**
 * Map a local wall-clock date and time in `timeZone` onto an absolute instant.
 *
 * The two candidate offsets are probed a day either side of the target, which
 * brackets any single transition. A local time that round-trips under exactly
 * one candidate is unambiguous; under two it happens twice (fall back); under
 * neither it does not happen at all (spring forward).
 *
 * Both irregular cases resolve *later*. For a deadline that is the direction
 * that cannot harm the consumer: an extra hour of window means at worst a
 * cancellation is honoured that could have been refused, whereas resolving
 * earlier means refusing one that was timely. The choice is returned on the
 * result so the derivation can say it out loud rather than bury it.
 */
export function instantFromZoned(local: CivilDateTime, timeZone: string): ZonedInstant {
  const localMs = msFromCivilDateTime(local);
  const offsetBefore = offsetMsAt(localMs - MS_PER_DAY, timeZone);
  const offsetAfter = offsetMsAt(localMs + MS_PER_DAY, timeZone);

  const candidates = [localMs - offsetBefore, localMs - offsetAfter];
  const valid: number[] = [];
  for (const candidate of candidates) {
    if (msFromCivilDateTime(zonedFieldsAt(candidate, timeZone)) === localMs) {
      if (!valid.includes(candidate)) valid.push(candidate);
    }
  }

  if (valid.length === 1) {
    const only = valid[0];
    if (only === undefined) throw new InvariantError("Candidate list lost its only member");
    return { instant: only, resolution: "unique" };
  }

  if (valid.length > 1) {
    return { instant: Math.max(...valid), resolution: "ambiguous_later" };
  }

  // Non-existent local time: the wall clock skipped over it. Resolving to the
  // later candidate lands just after the gap closes.
  return { instant: Math.max(...candidates), resolution: "nonexistent_shifted" };
}

/** The instant at which a civil date begins in `timeZone`. */
export function startOfLocalDay(date: CivilDate, timeZone: string): ZonedInstant {
  return instantFromZoned({ ...date, hour: 0, minute: 0, second: 0, millisecond: 0 }, timeZone);
}

// ---------------------------------------------------------------------------
// Holidays.
//
// PLACEHOLDER DATA. Nothing in the tables below has been verified against any
// jurisdiction's published holiday schedule. They are structural placeholders
// so the business-day engine can be exercised and reviewed. Every calendar is
// marked `verified: false` and carries the review note that must be discharged
// before it is used to compute a real deadline.
// ---------------------------------------------------------------------------

const HOLIDAY_REVIEW_NOTE =
  "PLACEHOLDER — UNVERIFIED. This holiday list has not been checked against any published schedule. " +
  "State-specific holidays have not been enumerated at all. MVW counsel must confirm the full list, " +
  "the observance rules, and whether the jurisdiction's rescission statute counts them, before use.";

function unverifiedHoliday(id: string, name: string, definition: Holiday["definition"]): Holiday {
  return { id, name, definition, verified: false };
}

/**
 * A widely-recognised base set, retained only to give the engine something to
 * count against. Its presence is not an assertion that these are the days any
 * particular state's rescission statute treats as non-business days.
 */
export const BASE_HOLIDAYS: readonly Holiday[] = [
  unverifiedHoliday("base.new_years_day", "New Year's Day", {
    kind: "fixed_date",
    month: 1,
    day: 1,
    observance: "nearest_weekday",
  }),
  unverifiedHoliday("base.january_third_monday", "Third Monday in January", {
    kind: "nth_weekday",
    month: 1,
    weekday: 1,
    nth: 3,
  }),
  unverifiedHoliday("base.february_third_monday", "Third Monday in February", {
    kind: "nth_weekday",
    month: 2,
    weekday: 1,
    nth: 3,
  }),
  unverifiedHoliday("base.may_last_monday", "Last Monday in May", {
    kind: "last_weekday",
    month: 5,
    weekday: 1,
  }),
  unverifiedHoliday("base.june_nineteenth", "June 19", {
    kind: "fixed_date",
    month: 6,
    day: 19,
    observance: "nearest_weekday",
  }),
  unverifiedHoliday("base.july_fourth", "July 4", {
    kind: "fixed_date",
    month: 7,
    day: 4,
    observance: "nearest_weekday",
  }),
  unverifiedHoliday("base.september_first_monday", "First Monday in September", {
    kind: "nth_weekday",
    month: 9,
    weekday: 1,
    nth: 1,
  }),
  unverifiedHoliday("base.october_second_monday", "Second Monday in October", {
    kind: "nth_weekday",
    month: 10,
    weekday: 1,
    nth: 2,
  }),
  unverifiedHoliday("base.november_eleventh", "November 11", {
    kind: "fixed_date",
    month: 11,
    day: 11,
    observance: "nearest_weekday",
  }),
  unverifiedHoliday("base.november_fourth_thursday", "Fourth Thursday in November", {
    kind: "nth_weekday",
    month: 11,
    weekday: 4,
    nth: 4,
  }),
  unverifiedHoliday("base.december_twenty_fifth", "December 25", {
    kind: "fixed_date",
    month: 12,
    day: 25,
    observance: "nearest_weekday",
  }),
];

/** Build a per-jurisdiction calendar from the base set plus any local additions. */
export function jurisdictionCalendar(
  jurisdiction: string,
  extras: readonly Holiday[] = [],
): HolidayCalendar {
  return {
    id: `US-${jurisdiction}`,
    label: `${jurisdiction} non-business days (placeholder)`,
    holidays: [...BASE_HOLIDAYS, ...extras],
    verified: false,
    reviewRequired: HOLIDAY_REVIEW_NOTE,
  };
}

const HOLIDAY_JURISDICTIONS: readonly string[] = [
  "FL",
  "SC",
  "NV",
  "CA",
  "HI",
  "AZ",
  "CO",
  "TX",
  "VA",
  "MO",
  "TN",
  "NY",
  "NJ",
  "MA",
  "UT",
  "NC",
  "GA",
  "MI",
  "WI",
  "IL",
];

/** A calendar with no holidays at all, for rules that count only weekends. */
export const NO_HOLIDAYS: HolidayCalendar = {
  id: "NONE",
  label: "No holidays observed",
  holidays: [],
  verified: false,
  reviewRequired:
    "PLACEHOLDER — UNVERIFIED. Asserting that a jurisdiction observes no holidays is itself a legal " +
    "claim and has not been checked. Confirm before relying on it.",
};

export const HOLIDAY_CALENDARS: HolidayCalendarTable = new Map<string, HolidayCalendar>([
  [NO_HOLIDAYS.id, NO_HOLIDAYS],
  ...HOLIDAY_JURISDICTIONS.map((code): [string, HolidayCalendar] => {
    const calendar = jurisdictionCalendar(code);
    return [calendar.id, calendar];
  }),
]);

function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: Weekday,
  nth: number,
): CivilDate | null {
  const first: CivilDate = { year, month, day: 1 };
  const shift = (weekday - dayOfWeek(first) + 7) % 7;
  const candidate = addDays(first, shift + (nth - 1) * 7);
  return candidate.month === month && candidate.year === year ? candidate : null;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: Weekday): CivilDate {
  const firstOfNext = month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 };
  const lastOfMonth = addDays(firstOfNext, -1);
  const back = (dayOfWeek(lastOfMonth) - weekday + 7) % 7;
  return addDays(lastOfMonth, -back);
}

/**
 * Where a holiday nominally falling in `year` is actually observed.
 *
 * The observed date can land outside `year` — January 1 falling on a Saturday
 * is observed on December 31 of the preceding year — which is why callers must
 * generate the neighbouring years and filter, rather than assuming a holiday
 * for year N is dated in year N.
 */
function observedDates(holiday: Holiday, year: number): readonly CivilDate[] {
  const definition = holiday.definition;
  switch (definition.kind) {
    case "fixed_date": {
      const nominal: CivilDate = { year, month: definition.month, day: definition.day };
      if (definition.observance === "none") return [nominal];
      const weekday = dayOfWeek(nominal);
      if (weekday === 6) return [addDays(nominal, -1)];
      if (weekday === 0) return [addDays(nominal, 1)];
      return [nominal];
    }
    case "nth_weekday": {
      const date = nthWeekdayOfMonth(year, definition.month, definition.weekday, definition.nth);
      return date ? [date] : [];
    }
    case "last_weekday":
      return [lastWeekdayOfMonth(year, definition.month, definition.weekday)];
    case "explicit_dates":
      return definition.dates
        .map((iso) => parseIsoDate(iso, `${holiday.id}.dates`))
        .filter((date) => date.year === year);
    default: {
      // Exhaustiveness: a new holiday shape must be handled here rather than
      // quietly contributing no dates and shortening someone's window.
      const unreachable: never = definition;
      throw new InvariantError(`Unhandled holiday definition: ${JSON.stringify(unreachable)}`);
    }
  }
}

const holidayIndexCache = new WeakMap<HolidayCalendar, Map<number, ReadonlyMap<IsoDate, string>>>();

/** Observed holidays falling within `year`, keyed by ISO date. */
export function holidaysInYear(
  calendar: HolidayCalendar,
  year: number,
): ReadonlyMap<IsoDate, string> {
  let byYear = holidayIndexCache.get(calendar);
  if (!byYear) {
    byYear = new Map();
    holidayIndexCache.set(calendar, byYear);
  }
  const cached = byYear.get(year);
  if (cached) return cached;

  const index = new Map<IsoDate, string>();
  // Neighbouring years are generated because an observance shift can move a
  // holiday across a year boundary in either direction.
  for (const nominalYear of [year - 1, year, year + 1]) {
    for (const holiday of calendar.holidays) {
      for (const date of observedDates(holiday, nominalYear)) {
        if (date.year !== year) continue;
        index.set(formatCivilDate(date), holiday.name);
      }
    }
  }
  byYear.set(year, index);
  return index;
}

/** The holiday observed on `date`, or null. */
export function holidayOn(date: CivilDate, calendar: HolidayCalendar): string | null {
  return holidaysInYear(calendar, date.year).get(formatCivilDate(date)) ?? null;
}

export function isWeekend(date: CivilDate, weekendDays: readonly Weekday[]): boolean {
  return weekendDays.includes(dayOfWeek(date));
}

export function isBusinessDay(
  date: CivilDate,
  calendar: HolidayCalendar,
  weekendDays: readonly Weekday[],
): boolean {
  return !isWeekend(date, weekendDays) && holidayOn(date, calendar) === null;
}

/**
 * Longest run of consecutive non-business days the roll will step over.
 *
 * A bound is required rather than optional: a malformed holiday calendar that
 * marks every day non-business would otherwise spin forever inside a request.
 * Ten days is far past any real run of closures and short enough to fail fast.
 */
export const MAX_ROLL_DAYS = 10;

/**
 * Advance to the next business day, if `date` is not one already.
 *
 * @throws {InvalidInputError} if no business day is found within
 *   {@link MAX_ROLL_DAYS}. That is a statement about the calendar it was given,
 *   not about this function, so callers computing a deadline convert it into a
 *   refusal rather than treating it as a platform fault.
 */
export function rollToBusinessDay(
  date: CivilDate,
  calendar: HolidayCalendar,
  weekendDays: readonly Weekday[],
): { readonly date: CivilDate; readonly skipped: readonly { date: IsoDate; reason: string }[] } {
  const skipped: { date: IsoDate; reason: string }[] = [];
  let cursor = date;
  for (let step = 0; step <= MAX_ROLL_DAYS; step += 1) {
    if (isBusinessDay(cursor, calendar, weekendDays)) {
      return { date: cursor, skipped };
    }
    skipped.push({ date: formatCivilDate(cursor), reason: describeNonBusinessDay(cursor, calendar) });
    cursor = addDays(cursor, 1);
  }
  throw new InvalidInputError(
    `No business day found within ${MAX_ROLL_DAYS} days of ${formatCivilDate(date)} using calendar ${calendar.id}. The holiday calendar is unusable.`,
    "holidayCalendar",
  );
}

/** Why a given day is not a business day, phrased for the derivation record. */
export function describeNonBusinessDay(date: CivilDate, calendar: HolidayCalendar): string {
  const holiday = holidayOn(date, calendar);
  if (holiday) return `${holiday} (observed holiday)`;
  return `${WEEKDAY_NAMES[dayOfWeek(date)] ?? "weekend day"} (weekend)`;
}
