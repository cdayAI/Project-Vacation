import { compareCivilDates, isKnownTimeZone, parseIsoDate } from "./calendar.js";
import type { JurisdictionEntry, JurisdictionTable, RescissionRule, Weekday } from "./types.js";

/**
 * ============================================================================
 * NOT LAW. NOTHING IN THIS FILE HAS BEEN VERIFIED AGAINST CURRENT STATUTE.
 * ============================================================================
 *
 * Every rule below is a PLACEHOLDER. The window lengths, the counting bases,
 * the trigger events, the weekend and holiday roll behaviour, the effective
 * dates — all of it is invented to exercise the computation engine and to give
 * counsel a concrete shape to correct. None of it was read out of a statute,
 * and no citation here points at a real provision.
 *
 * Concretely:
 *   - Every rule carries `verified: false`.
 *   - Every `citation` begins with the placeholder marker and names no real
 *     statutory provision. Fabricating a plausible-looking citation would be
 *     worse than having none, because a plausible citation gets believed.
 *   - Every `sourceUrl` is empty, for the same reason.
 *   - Every rule carries a `reviewRequired` note naming what must be confirmed.
 *
 * Before ANY production use, MVW counsel must confirm, per state and per
 * effective period: the window length; whether it is calendar or business days;
 * what starts the clock and whether delivery of the public offering statement
 * or other disclosure documents can start it later than execution; whether the
 * trigger day itself counts; what happens when the last day is a weekend or a
 * state holiday; which holidays the state actually observes for this purpose;
 * the governing timezone where a state spans more than one; and whether the
 * rule has changed within the retention period of contracts still in force.
 *
 * Two structural protections back this up. `validateRuleTable` refuses any rule
 * that claims `verified: true` without both a citation and a source URL, and a
 * test asserts the shipped table has no problems. Separately,
 * `computeRescissionDeadline` accepts `requireVerifiedRules`, which a
 * production deployment sets so that an unverified rule denies rather than
 * produces a number somebody might act on.
 */

/** Marker that must open the citation of any rule that is not verified. */
export const PLACEHOLDER_MARKER = "PLACEHOLDER — UNVERIFIED";

const REVIEW_NOTE =
  "Confirm with MVW counsel: statutory citation, window length, calendar-vs-business-day basis, " +
  "trigger event (execution vs delivery of the public offering statement or disclosure documents), " +
  "whether the trigger day counts, weekend and state-holiday roll behaviour, governing timezone, and " +
  "the effective period. No element of this rule has been verified.";

const END_OF_DAY = { hour: 23, minute: 59, second: 59, millisecond: 999 } as const;
const WEEKEND: readonly Weekday[] = [0, 6];

/** Fields a placeholder rule must supply; provenance is stamped on for it. */
type PlaceholderRule = Omit<
  RescissionRule,
  "citation" | "sourceUrl" | "verified" | "reviewRequired" | "weekendDays" | "endOfDay"
> & {
  readonly weekendDays?: readonly Weekday[];
  readonly endOfDay?: RescissionRule["endOfDay"];
};

/**
 * Stamp the provenance fields on a placeholder rule.
 *
 * Going through a constructor rather than repeating the fields per row is not
 * only brevity: it makes it structurally impossible for a row in this table to
 * acquire `verified: true` by being copy-pasted. Marking a rule verified
 * requires leaving this helper behind and supplying a citation and URL, which
 * is exactly the friction the honesty requirement wants.
 */
function placeholder(rule: PlaceholderRule): RescissionRule {
  return {
    ...rule,
    weekendDays: rule.weekendDays ?? WEEKEND,
    endOfDay: rule.endOfDay ?? END_OF_DAY,
    citation: `${PLACEHOLDER_MARKER}: no statutory citation has been confirmed for ${rule.jurisdiction}.`,
    sourceUrl: "",
    verified: false,
    reviewRequired: REVIEW_NOTE,
  };
}

/**
 * The jurisdictions where vacation ownership is commonly sold.
 *
 * The structural variation between rows — business days here, calendar days
 * there, later-of triggers, rolls on and off — is deliberate. It is not a claim
 * about any state. It exists so the engine is exercised across every shape the
 * type system permits, and so a reviewer correcting the table can see what each
 * field does by comparing rows.
 */
const ENTRIES: readonly JurisdictionEntry[] = [
  {
    jurisdiction: "FL",
    label: "Florida",
    versions: [
      // Two versions so effective-dating is exercised, not merely modelled.
      // The earlier version is synthetic; it is not a record of a real
      // historical amendment.
      placeholder({
        jurisdiction: "FL",
        version: "FL@1",
        windowLength: 10,
        basis: "calendar_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "none",
        holidayCalendarId: "US-FL",
        timeZone: "America/New_York",
        timeZoneNote:
          "Florida spans Eastern and Central time; the western panhandle is Central. Using a single " +
          "zone for the whole state is a simplification that must be reviewed.",
        effectiveFrom: "2000-01-01",
        effectiveTo: "2019-12-31",
      }),
      placeholder({
        jurisdiction: "FL",
        version: "FL@2",
        windowLength: 10,
        basis: "calendar_days",
        trigger: "later_of_execution_or_delivery",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-FL",
        timeZone: "America/New_York",
        timeZoneNote:
          "Florida spans Eastern and Central time; the western panhandle is Central. Using a single " +
          "zone for the whole state is a simplification that must be reviewed.",
        effectiveFrom: "2020-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "SC",
    label: "South Carolina",
    versions: [
      placeholder({
        jurisdiction: "SC",
        version: "SC@1",
        windowLength: 5,
        basis: "calendar_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-SC",
        timeZone: "America/New_York",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "NV",
    label: "Nevada",
    versions: [
      placeholder({
        jurisdiction: "NV",
        version: "NV@1",
        windowLength: 5,
        basis: "calendar_days",
        trigger: "later_of_execution_or_delivery",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-NV",
        timeZone: "America/Los_Angeles",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "CA",
    label: "California",
    versions: [
      placeholder({
        jurisdiction: "CA",
        version: "CA@1",
        windowLength: 7,
        basis: "calendar_days",
        trigger: "later_of_execution_or_delivery",
        countingStart: "day_after_trigger",
        roll: "none",
        holidayCalendarId: "US-CA",
        timeZone: "America/Los_Angeles",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "HI",
    label: "Hawaii",
    versions: [
      placeholder({
        jurisdiction: "HI",
        version: "HI@1",
        windowLength: 7,
        basis: "calendar_days",
        trigger: "document_delivery",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-HI",
        // Hawaii does not observe daylight saving. Kept as a named zone anyway:
        // hard-coding -10:00 would be right today and wrong the moment that
        // changes, and a named zone costs nothing.
        timeZone: "Pacific/Honolulu",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "AZ",
    label: "Arizona",
    versions: [
      placeholder({
        jurisdiction: "AZ",
        version: "AZ@1",
        windowLength: 7,
        basis: "calendar_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "none",
        holidayCalendarId: "US-AZ",
        // Most of Arizona does not observe daylight saving; the Navajo Nation
        // does. America/Phoenix covers the former only.
        timeZone: "America/Phoenix",
        timeZoneNote:
          "America/Phoenix does not observe daylight saving. Parts of the Navajo Nation within Arizona " +
          "do. Confirm which zone governs a contract executed there.",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "CO",
    label: "Colorado",
    versions: [
      placeholder({
        jurisdiction: "CO",
        version: "CO@1",
        windowLength: 5,
        basis: "calendar_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-CO",
        timeZone: "America/Denver",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "TX",
    label: "Texas",
    versions: [
      placeholder({
        jurisdiction: "TX",
        version: "TX@1",
        windowLength: 6,
        basis: "calendar_days",
        trigger: "later_of_execution_or_delivery",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-TX",
        timeZone: "America/Chicago",
        timeZoneNote:
          "Texas spans Central and Mountain time; the far west of the state is Mountain. Using a " +
          "single zone is a simplification that must be reviewed.",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "VA",
    label: "Virginia",
    versions: [
      placeholder({
        jurisdiction: "VA",
        version: "VA@1",
        windowLength: 7,
        basis: "calendar_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "none",
        holidayCalendarId: "US-VA",
        timeZone: "America/New_York",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "MO",
    label: "Missouri",
    versions: [
      placeholder({
        jurisdiction: "MO",
        version: "MO@1",
        windowLength: 5,
        basis: "business_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "none",
        holidayCalendarId: "US-MO",
        timeZone: "America/Chicago",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "TN",
    label: "Tennessee",
    versions: [
      placeholder({
        jurisdiction: "TN",
        version: "TN@1",
        windowLength: 10,
        basis: "calendar_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-TN",
        timeZone: "America/Chicago",
        timeZoneNote:
          "Tennessee spans Central and Eastern time; the eastern third is Eastern. Using a single " +
          "zone is a simplification that must be reviewed.",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "NY",
    label: "New York",
    versions: [
      placeholder({
        jurisdiction: "NY",
        version: "NY@1",
        windowLength: 7,
        basis: "calendar_days",
        trigger: "later_of_execution_or_delivery",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-NY",
        timeZone: "America/New_York",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "NJ",
    label: "New Jersey",
    versions: [
      placeholder({
        jurisdiction: "NJ",
        version: "NJ@1",
        windowLength: 7,
        basis: "calendar_days",
        trigger: "later_of_execution_or_delivery",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-NJ",
        timeZone: "America/New_York",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "MA",
    label: "Massachusetts",
    versions: [
      placeholder({
        jurisdiction: "MA",
        version: "MA@1",
        windowLength: 3,
        basis: "business_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "none",
        holidayCalendarId: "US-MA",
        timeZone: "America/New_York",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "UT",
    label: "Utah",
    versions: [
      placeholder({
        jurisdiction: "UT",
        version: "UT@1",
        windowLength: 5,
        basis: "calendar_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-UT",
        timeZone: "America/Denver",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "NC",
    label: "North Carolina",
    versions: [
      placeholder({
        jurisdiction: "NC",
        version: "NC@1",
        windowLength: 5,
        basis: "calendar_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-NC",
        timeZone: "America/New_York",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "GA",
    label: "Georgia",
    versions: [
      placeholder({
        jurisdiction: "GA",
        version: "GA@1",
        windowLength: 7,
        basis: "calendar_days",
        trigger: "later_of_execution_or_delivery",
        countingStart: "day_after_trigger",
        roll: "none",
        holidayCalendarId: "US-GA",
        timeZone: "America/New_York",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "MI",
    label: "Michigan",
    versions: [
      placeholder({
        jurisdiction: "MI",
        version: "MI@1",
        windowLength: 9,
        basis: "business_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "none",
        holidayCalendarId: "US-MI",
        timeZone: "America/Detroit",
        timeZoneNote:
          "Four counties in Michigan's western Upper Peninsula observe Central time. Using a single " +
          "zone is a simplification that must be reviewed.",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "WI",
    label: "Wisconsin",
    versions: [
      placeholder({
        jurisdiction: "WI",
        version: "WI@1",
        windowLength: 5,
        basis: "business_days",
        trigger: "later_of_execution_or_delivery",
        countingStart: "day_after_trigger",
        roll: "none",
        holidayCalendarId: "US-WI",
        timeZone: "America/Chicago",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    jurisdiction: "IL",
    label: "Illinois",
    versions: [
      placeholder({
        jurisdiction: "IL",
        version: "IL@1",
        windowLength: 5,
        basis: "calendar_days",
        trigger: "contract_execution",
        countingStart: "day_after_trigger",
        roll: "next_business_day",
        holidayCalendarId: "US-IL",
        timeZone: "America/Chicago",
        effectiveFrom: "2000-01-01",
        effectiveTo: null,
      }),
    ],
  },
  {
    /**
     * The fallback, expressed as data with no rule in it.
     *
     * A jurisdiction the platform does not have a rule for must refuse, not
     * guess, not borrow a neighbouring state's window, and not fall back to
     * "the shortest one, to be safe" — a short window rejects timely
     * cancellations. Zero versions means the ordinary "no version covers this
     * contract" path denies it, so there is no separate fallback branch that
     * could be forgotten or mis-edited.
     */
    jurisdiction: "DEFAULT",
    label: "No rule on file",
    versions: [],
  },
];

export const RESCISSION_RULES: JurisdictionTable = new Map(
  ENTRIES.map((entry): [string, JurisdictionEntry] => [entry.jurisdiction, entry]),
);

/** The refusing fallback, used when a state code has no entry of its own. */
export const DEFAULT_JURISDICTION: JurisdictionEntry = {
  jurisdiction: "DEFAULT",
  label: "No rule on file",
  versions: [],
};

/** Longest window the engine will compute, before or after tolling. */
export const MAX_WINDOW_DAYS = 400;

export interface RuleProblem {
  readonly jurisdiction: string;
  readonly version: string;
  readonly problem: string;
}

/**
 * Structural and provenance checks over a rule table.
 *
 * The check that matters most is the first: a rule may not claim to be verified
 * without a citation and a source URL. That is the difference between "someone
 * checked this" and "someone ticked a box", and it is the one a test asserts on
 * every build so the claim cannot rot into a lie between releases.
 *
 * The rest catch the data errors that would otherwise surface as a wrong
 * deadline rather than an error: overlapping effective periods (which version
 * governs?), an unknown timezone, a window that is not a positive whole number.
 */
export function validateRuleTable(table: JurisdictionTable): readonly RuleProblem[] {
  const problems: RuleProblem[] = [];

  for (const entry of table.values()) {
    const seenVersions = new Set<string>();

    for (const rule of entry.versions) {
      const at = (problem: string): void => {
        problems.push({ jurisdiction: entry.jurisdiction, version: rule.version, problem });
      };

      if (rule.verified) {
        if (rule.citation.trim().length === 0) {
          at("Rule is marked verified but carries no citation.");
        }
        if (rule.sourceUrl.trim().length === 0) {
          at("Rule is marked verified but carries no source URL.");
        }
        if (rule.citation.includes(PLACEHOLDER_MARKER)) {
          at("Rule is marked verified but its citation is still a placeholder.");
        }
      } else if (!rule.citation.startsWith(PLACEHOLDER_MARKER)) {
        // An unverified rule whose citation reads like a real one is the
        // dangerous direction: it gets quoted.
        at(`Unverified rule's citation must begin with "${PLACEHOLDER_MARKER}".`);
      }

      if (rule.reviewRequired.trim().length === 0) {
        at("Rule carries no review note.");
      }
      if (rule.jurisdiction !== entry.jurisdiction) {
        at(`Rule's jurisdiction "${rule.jurisdiction}" does not match its entry.`);
      }
      if (seenVersions.has(rule.version)) {
        at("Duplicate version identifier within a jurisdiction.");
      }
      seenVersions.add(rule.version);

      if (!Number.isInteger(rule.windowLength) || rule.windowLength < 1) {
        at(`Window length must be a positive whole number, found ${rule.windowLength}.`);
      }
      if (rule.windowLength > MAX_WINDOW_DAYS) {
        at(`Window length ${rule.windowLength} exceeds the ${MAX_WINDOW_DAYS}-day sanity bound.`);
      }
      if (!isKnownTimeZone(rule.timeZone)) {
        at(`"${rule.timeZone}" is not an IANA timezone this runtime recognises.`);
      }
      if (rule.weekendDays.length >= 7) {
        at("Every day of the week is marked a weekend; no day could ever count.");
      }

      let from: ReturnType<typeof parseIsoDate> | null = null;
      try {
        from = parseIsoDate(rule.effectiveFrom, "effectiveFrom");
      } catch (error) {
        at(error instanceof Error ? error.message : String(error));
      }
      if (rule.effectiveTo !== null) {
        try {
          const to = parseIsoDate(rule.effectiveTo, "effectiveTo");
          if (from && compareCivilDates(to, from) < 0) {
            at("effectiveTo is earlier than effectiveFrom.");
          }
        } catch (error) {
          at(error instanceof Error ? error.message : String(error));
        }
      }
    }

    problems.push(...overlappingVersions(entry));
  }

  return problems;
}

/**
 * Detect effective periods that overlap.
 *
 * Overlap is not a cosmetic problem. If two versions both cover a contract's
 * date, the engine cannot know which law governs it, and picking the first or
 * the newest would be a silent choice with legal consequence. So overlap is
 * reported here and refused at computation time.
 */
function overlappingVersions(entry: JurisdictionEntry): readonly RuleProblem[] {
  const problems: RuleProblem[] = [];
  const parsed: { rule: RescissionRule; from: number; to: number }[] = [];

  for (const rule of entry.versions) {
    try {
      const from = parseIsoDate(rule.effectiveFrom, "effectiveFrom");
      const to = rule.effectiveTo === null ? null : parseIsoDate(rule.effectiveTo, "effectiveTo");
      parsed.push({
        rule,
        from: from.year * 10_000 + from.month * 100 + from.day,
        to: to === null ? Number.POSITIVE_INFINITY : to.year * 10_000 + to.month * 100 + to.day,
      });
    } catch {
      // Malformed dates are already reported by the caller; skip the overlap
      // check for this row rather than reporting the same fault twice.
    }
  }

  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = i + 1; j < parsed.length; j += 1) {
      const a = parsed[i];
      const b = parsed[j];
      if (!a || !b) continue;
      if (a.from <= b.to && b.from <= a.to) {
        problems.push({
          jurisdiction: entry.jurisdiction,
          version: `${a.rule.version}/${b.rule.version}`,
          problem: `Effective periods of ${a.rule.version} and ${b.rule.version} overlap.`,
        });
      }
    }
  }

  return problems;
}
