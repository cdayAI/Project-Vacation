/**
 * Statutory clocks.
 *
 * The one place in the platform that computes a legal deadline. Nothing else
 * may do date arithmetic on a statutory period — not the workflow engine, not a
 * document template, not a model. If a deadline is needed, it comes from here
 * with its derivation attached, or it does not come at all.
 *
 * There is no persistence port and no migration in this module, and that is a
 * decision rather than an omission. Rescission rules are declarative artifacts
 * in version control, reviewed by counsel through the same diff and approval
 * path as any other change. A rule that could be edited in a database would be
 * a legal control with no review, no history, and no way to answer "what did it
 * say last March". Tolling events belong to the contract they toll and are
 * supplied by the caller from the operating record, which keeps this module a
 * pure function of its inputs — the property that makes the seeded demo
 * reproducible and the tests independent of wall-clock time.
 */

export type {
  AppliedTolling,
  CivilDate,
  CivilDateTime,
  CivilTime,
  CountingStart,
  DayCountBasis,
  DeadlineComputation,
  DerivationStep,
  Holiday,
  HolidayCalendar,
  HolidayCalendarTable,
  HolidayDefinition,
  IsoDate,
  IsoInstant,
  JurisdictionEntry,
  JurisdictionTable,
  LocalDeadlineTime,
  RescissionInput,
  RescissionRule,
  TollingCode,
  TollingEvent,
  TollingKind,
  TriggerEvent,
  UncountedDay,
  Weekday,
  WeekendRollRule,
  ZonedResolution,
} from "./types.js";

export { WEEKDAY_NAMES } from "./types.js";

export {
  BASE_HOLIDAYS,
  HOLIDAY_CALENDARS,
  MAX_ROLL_DAYS,
  NO_HOLIDAYS,
  addDays,
  civilFromDays,
  compareCivilDates,
  dayOfWeek,
  daysFromCivil,
  describeNonBusinessDay,
  formatCivilDate,
  formatInstant,
  formatOffset,
  holidayOn,
  holidaysInYear,
  instantFromZoned,
  isBusinessDay,
  isKnownTimeZone,
  isWeekend,
  jurisdictionCalendar,
  localDateAt,
  offsetMsAt,
  parseIsoDate,
  parseIsoInstant,
  rollToBusinessDay,
  startOfLocalDay,
  zonedFieldsAt,
} from "./calendar.js";
export type { ZonedInstant } from "./calendar.js";

export {
  DEFAULT_JURISDICTION,
  MAX_WINDOW_DAYS,
  PLACEHOLDER_MARKER,
  RESCISSION_RULES,
  validateRuleTable,
} from "./rules.js";
export type { RuleProblem } from "./rules.js";

export {
  MAX_TOLLING_DAYS,
  MAX_TOLLING_EVENTS,
  MAX_TOTAL_EXTENSION_DAYS,
  planTolling,
} from "./tolling.js";
export type { TollingPlan } from "./tolling.js";

export {
  computeRescissionDeadline,
  deadlineFingerprint,
  isWithinRescissionWindow,
} from "./compute.js";
export type { ComputeOptions } from "./compute.js";
