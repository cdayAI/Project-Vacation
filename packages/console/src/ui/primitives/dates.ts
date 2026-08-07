/**
 * Dates, as text an operator types and as a string the record stores.
 *
 * Two rules govern everything here.
 *
 * **The stored value is an ISO calendar date, `YYYY-MM-DD`, and never a `Date`.**
 * A `Date` is an instant, and an instant carries a time zone. A statutory
 * rescission window that starts on 12 June starts on 12 June in Florida whether
 * the browser is in Orlando or Frankfurt; passing a `Date` across this boundary
 * is how the same record shows two different days to two operators.
 *
 * **No format is ever inferred from the platform locale.** `12/06/2026` is the
 * twelfth of June to most of the world and the sixth of December to the United
 * States, and there is no way to tell which one an operator meant. Guessing from
 * `navigator.language` means the same keystrokes produce different dates on
 * different machines, silently, and the mistake surfaces months later in a
 * compliance report. So a slashed date is *rejected* with a message naming what
 * to type instead, and every accepted form has a written-out month, which cannot
 * be ambiguous in any order:
 *
 *     12 Jun 2026    12 June 2026    Jun 12 2026    June 12, 2026
 *     12 Jun         (this year, or the picker's reference year)
 *     2026-06-12     (ISO, the form the record stores)
 *
 * That is a deliberate trade: an operator working a queue types "12 Jun" faster
 * than they can click, and typing it wrong is impossible.
 */

export const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Sunday, written down rather than read from the platform.
 *
 * The operators this console is built for work United States business weeks and
 * read Sunday-first calendars; taking it from the browser's locale would mean a
 * screenshot in a training document does not match what the trainee sees.
 */
export const WEEK_STARTS_ON = 0;

export const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"] as const;
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Said in the field hint, so the accepted formats are never a secret. */
export const DATE_FORMAT_HINT = "Type a date as 12 Jun 2026 or 2026-06-12, or pick one.";

export interface CalendarDate {
  readonly year: number;
  readonly month: number; // 1–12, not the platform's 0–11
  readonly day: number;
}

export type ParseFailure = "empty" | "ambiguous" | "unrecognised" | "impossible";

export type ParseResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ParseFailure };

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function toIso(date: CalendarDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

export function fromIso(iso: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one, and this arithmetic is
  // where leap years are handled once instead of in four places.
  return new Date(year, month, 0).getDate();
}

/** The weekday of the first of the month, 0 = Sunday. */
export function firstWeekdayOfMonth(year: number, month: number): number {
  return new Date(year, month - 1, 1).getDay();
}

export function weekdayOf(iso: string): number {
  const date = fromIso(iso);
  if (date === null) return 0;
  return new Date(date.year, date.month - 1, date.day).getDay();
}

/** Today, in the browser's own calendar. Injectable so tests are not seasonal. */
export function todayIso(now: Date = new Date()): string {
  return toIso({ year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() });
}

export function addDays(iso: string, days: number): string {
  const date = fromIso(iso);
  if (date === null) return iso;
  const shifted = new Date(date.year, date.month - 1, date.day + days);
  return toIso({
    year: shifted.getFullYear(),
    month: shifted.getMonth() + 1,
    day: shifted.getDate(),
  });
}

/**
 * Adds months, clamping the day to the end of the target month.
 *
 * 31 January plus one month is 28 February, not 3 March. The platform's own
 * arithmetic overflows into the next month, which in a date picker means
 * pressing Page Down on the 31st skips February entirely.
 */
export function addMonths(iso: string, months: number): string {
  const date = fromIso(iso);
  if (date === null) return iso;
  const target = date.month - 1 + months;
  const year = date.year + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12; // 0-based
  const day = Math.min(date.day, daysInMonth(year, month + 1));
  return toIso({ year, month: month + 1, day });
}

/** −1, 0, 1. String comparison is correct for zero-padded ISO dates. */
export function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isWithin(iso: string, min?: string, max?: string): boolean {
  if (min !== undefined && compareIso(iso, min) < 0) return false;
  if (max !== undefined && compareIso(iso, max) > 0) return false;
  return true;
}

/** `2026-06-12` → `12 Jun 2026`. The only shape the console displays. */
export function formatDate(iso: string): string {
  const date = fromIso(iso);
  if (date === null) return "";
  return `${date.day} ${MONTHS_SHORT[date.month - 1]} ${date.year}`;
}

/** `2026-06-12` → `12 June 2026`. For an accessible name, where "Jun" is read aloud. */
export function formatDateSpoken(iso: string): string {
  const date = fromIso(iso);
  if (date === null) return "";
  return `${date.day} ${MONTHS_LONG[date.month - 1]} ${date.year}`;
}

export function formatMonth(year: number, month: number): string {
  return `${MONTHS_LONG[month - 1]} ${year}`;
}

function monthFromName(name: string): number | null {
  const needle = name.toLowerCase();
  if (needle.length < 3) return null;
  for (let index = 0; index < MONTHS_LONG.length; index += 1) {
    if (MONTHS_LONG[index]?.toLowerCase().startsWith(needle)) return index + 1;
  }
  return null;
}

const ISO_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
/** Anything built out of digits and slashes or dots: the ambiguous family. */
const SLASHED_PATTERN = /^\d{1,4}\s*[/.]\s*\d{1,2}(\s*[/.]\s*\d{1,4})?$/;
const DAY_MONTH_PATTERN = /^(\d{1,2})[\s,-]+([A-Za-z]+)(?:[\s,-]+(\d{4}))?$/;
const MONTH_DAY_PATTERN = /^([A-Za-z]+)[\s,-]+(\d{1,2})(?:[\s,-]+(\d{4}))?$/;

/**
 * Parses what an operator typed.
 *
 * `referenceYear` is the year a date with no year belongs to — the year of the
 * value being edited, or the current one. Stated explicitly rather than assumed
 * to be "now" so that editing a 2024 record and typing "3 Mar" does not silently
 * move it two years forward.
 */
export function parseDate(input: string, referenceYear: number): ParseResult {
  const text = input.trim().replace(/\s+/g, " ");
  if (text.length === 0) return { ok: false, reason: "empty" };

  const iso = ISO_PATTERN.exec(text);
  if (iso !== null) {
    return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  // Checked before the word forms so that "12/06/2026" is reported as ambiguous
  // rather than as unrecognised. The difference matters: one message tells the
  // operator what to type, the other tells them they are wrong.
  if (SLASHED_PATTERN.test(text)) return { ok: false, reason: "ambiguous" };

  const dayFirst = DAY_MONTH_PATTERN.exec(text);
  if (dayFirst !== null) {
    const month = monthFromName(dayFirst[2] ?? "");
    if (month === null) return { ok: false, reason: "unrecognised" };
    const year = dayFirst[3] === undefined ? referenceYear : Number(dayFirst[3]);
    return build(year, month, Number(dayFirst[1]));
  }

  const monthFirst = MONTH_DAY_PATTERN.exec(text);
  if (monthFirst !== null) {
    const month = monthFromName(monthFirst[1] ?? "");
    if (month === null) return { ok: false, reason: "unrecognised" };
    const year = monthFirst[3] === undefined ? referenceYear : Number(monthFirst[3]);
    return build(year, month, Number(monthFirst[2]));
  }

  return { ok: false, reason: "unrecognised" };
}

function build(year: number, month: number, day: number): ParseResult {
  if (month < 1 || month > 12) return { ok: false, reason: "impossible" };
  if (year < 1000 || year > 9999) return { ok: false, reason: "impossible" };
  if (day < 1 || day > daysInMonth(year, month)) return { ok: false, reason: "impossible" };
  return { ok: true, value: toIso({ year, month, day }) };
}

/**
 * The sentence shown when a date will not parse.
 *
 * Written to §6: what happened, what it means, what to do. Never "Invalid
 * input", which tells an operator nothing and reads as an accusation.
 */
export function describeParseFailure(reason: ParseFailure): string {
  switch (reason) {
    case "empty":
      return "Enter a date, or pick one from the calendar.";
    case "ambiguous":
      return "A date written with slashes could be either day-first or month-first, so we do not guess. Write the month as a word — 12 Jun 2026 — or use 2026-06-12.";
    case "impossible":
      return "That day does not exist in that month. Check the day and the month.";
    case "unrecognised":
      return "We could not read that as a date. Write it as 12 Jun 2026 or 2026-06-12.";
  }
}

/** The message for a date outside the allowed window, with both ends named. */
export function describeOutOfRange(min?: string, max?: string): string {
  if (min !== undefined && max !== undefined) {
    return `Choose a date between ${formatDate(min)} and ${formatDate(max)}.`;
  }
  if (min !== undefined) return `Choose a date on or after ${formatDate(min)}.`;
  if (max !== undefined) return `Choose a date on or before ${formatDate(max)}.`;
  return "Choose a date in the allowed range.";
}

/**
 * The six-week grid a month is drawn on, as ISO dates including the days either
 * side that fill the first and last rows.
 *
 * Always six rows. A grid that is five rows in February and six in March moves
 * everything below the calendar when the operator pages between months, and a
 * popup that changes height under the pointer is how the wrong day gets clicked.
 */
export function monthGrid(year: number, month: number): readonly string[] {
  const leading = (firstWeekdayOfMonth(year, month) - WEEK_STARTS_ON + 7) % 7;
  const first = toIso({ year, month, day: 1 });
  const start = addDays(first, -leading);
  const cells: string[] = [];
  for (let index = 0; index < 42; index += 1) cells.push(addDays(start, index));
  return cells;
}
