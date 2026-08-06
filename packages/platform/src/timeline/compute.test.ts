import { describe, it, expect } from "vitest";
import { canonicalJson } from "../kernel/canonical.js";
import { FixedClock } from "../kernel/clock.js";
import { DeniedError, isDenied } from "../kernel/errors.js";
import { HOLIDAY_CALENDARS, addDays, formatCivilDate, jurisdictionCalendar } from "./calendar.js";
import {
  computeRescissionDeadline,
  deadlineFingerprint,
  isWithinRescissionWindow,
  type ComputeOptions,
} from "./compute.js";
import { PLACEHOLDER_MARKER } from "./rules.js";
import { MAX_TOLLING_DAYS } from "./tolling.js";
import type {
  HolidayCalendar,
  HolidayCalendarTable,
  JurisdictionTable,
  RescissionRule,
  TollingEvent,
} from "./types.js";

const clock = new FixedClock("2026-08-06T12:00:00.000Z");
const base: ComputeOptions = { clock };

function rule(overrides: Partial<RescissionRule> = {}): RescissionRule {
  return {
    jurisdiction: "ZZ",
    version: "ZZ@1",
    windowLength: 3,
    basis: "calendar_days",
    trigger: "contract_execution",
    countingStart: "day_after_trigger",
    roll: "none",
    weekendDays: [0, 6],
    holidayCalendarId: "NONE",
    endOfDay: { hour: 23, minute: 59, second: 59, millisecond: 999 },
    timeZone: "America/New_York",
    effectiveFrom: "2000-01-01",
    effectiveTo: null,
    citation: `${PLACEHOLDER_MARKER}: test fixture.`,
    sourceUrl: "",
    verified: false,
    reviewRequired: "test fixture",
    ...overrides,
  };
}

/** A one-jurisdiction table under the code `ZZ`, built from the given versions. */
function tableOf(...versions: readonly RescissionRule[]): JurisdictionTable {
  return new Map([["ZZ", { jurisdiction: "ZZ", label: "Test jurisdiction", versions }]]);
}

function tollingEvent(overrides: Partial<TollingEvent> = {}): TollingEvent {
  return {
    kind: "suspend",
    code: "documents_redelivered",
    reason: "Corrected disclosure package re-delivered to the purchaser.",
    authority: "Signed acknowledgement of re-delivery, filed with the contract.",
    recordedBy: "act_test",
    effectiveAt: "2026-03-06T12:00:00.000Z",
    endsAt: "2026-03-07T12:00:00.000Z",
    ...overrides,
  };
}

function denialReason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isDenied(error)) return error.reason;
    throw error;
  }
  throw new Error("Expected a denial, but the call returned a deadline.");
}

describe("computing a deadline from the shipped table", () => {
  it("derives a Florida deadline and shows its working", () => {
    const result = computeRescissionDeadline(
      {
        stateCode: "FL",
        contractExecutedAt: "2026-03-05T14:00:00.000Z",
        documentsDeliveredAt: "2026-03-05T14:00:00.000Z",
      },
      base,
    );

    expect(result.ruleVersion).toBe("FL@2");
    expect(result.timeZone).toBe("America/New_York");
    expect(result.triggerLocalDate).toBe("2026-03-05");
    expect(result.countingStartDate).toBe("2026-03-06");
    // Ten calendar days lands on a Sunday, and this rule rolls forward.
    expect(result.rawDeadlineDate).toBe("2026-03-15");
    expect(result.deadlineLocalDate).toBe("2026-03-16");
    expect(result.deadlineInstant).toBe("2026-03-17T03:59:59.999Z");
    expect(result.utcOffsetAtDeadline).toBe("-04:00");
    expect(result.computedAt).toBe("2026-08-06T12:00:00.000Z");

    const labels = result.steps.map((s) => s.label);
    expect(labels).toEqual([
      "jurisdiction.resolved",
      "governing_date.resolved",
      "rule.selected",
      "trigger.resolved",
      "counting.start",
      "counting.completed",
      "roll.applied",
      "deadline.resolved",
    ]);
    expect(result.steps.every((s) => s.detail.length > 0)).toBe(true);
  });

  it("carries the unverified-rule warning on every computation from the placeholder table", () => {
    const result = computeRescissionDeadline(
      { stateCode: "SC", contractExecutedAt: "2026-05-01T14:00:00.000Z" },
      base,
    );
    expect(result.ruleVerified).toBe(false);
    expect(result.citation.startsWith(PLACEHOLDER_MARKER)).toBe(true);
    expect(result.warnings.join(" ")).toContain("UNVERIFIED");
  });

  it("normalises the state code without inventing one", () => {
    const spaced = computeRescissionDeadline(
      { stateCode: "  fl ", contractExecutedAt: "2026-03-05T14:00:00.000Z", documentsDeliveredAt: "2026-03-05T14:00:00.000Z" },
      base,
    );
    expect(spaced.jurisdiction).toBe("FL");
  });

  it("keeps a Hawaii deadline at a constant offset, because that zone has no daylight saving", () => {
    const winter = computeRescissionDeadline(
      { stateCode: "HI", documentsDeliveredAt: "2026-01-05T20:00:00.000Z" },
      base,
    );
    const summer = computeRescissionDeadline(
      { stateCode: "HI", documentsDeliveredAt: "2026-07-05T20:00:00.000Z" },
      base,
    );
    expect(winter.utcOffsetAtDeadline).toBe("-10:00");
    expect(summer.utcOffsetAtDeadline).toBe("-10:00");
  });
});

describe("refusals", () => {
  it("refuses a state it has no rule for, rather than borrowing a neighbour's window", () => {
    expect(denialReason(() => computeRescissionDeadline({ stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" }, base))).toBe(
      "knowledge.no_grounding",
    );
  });

  it("refuses the DEFAULT fallback itself", () => {
    expect(
      denialReason(() =>
        computeRescissionDeadline({ stateCode: "DEFAULT", contractExecutedAt: "2026-03-05T14:00:00.000Z" }, base),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses a state code that names a JavaScript prototype member", () => {
    // The rule table is a Map precisely so `constructor` cannot resolve to
    // something inherited and be mistaken for a jurisdiction.
    for (const probe of ["constructor", "toString", "hasOwnProperty"]) {
      expect(
        denialReason(() =>
          computeRescissionDeadline({ stateCode: probe, contractExecutedAt: "2026-03-05T14:00:00.000Z" }, base),
        ),
      ).toBe("knowledge.no_grounding");
    }
  });

  it("refuses a missing or empty jurisdiction", () => {
    expect(denialReason(() => computeRescissionDeadline({ stateCode: "" }, base))).toBe(
      "knowledge.no_grounding",
    );
    expect(
      denialReason(() =>
        computeRescissionDeadline({ stateCode: "F1", contractExecutedAt: "2026-03-05T14:00:00.000Z" }, base),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses when no trigger date at all was supplied", () => {
    expect(denialReason(() => computeRescissionDeadline({ stateCode: "FL" }, base))).toBe(
      "knowledge.no_grounding",
    );
  });

  it("refuses when the rule needs delivery and only execution was supplied", () => {
    // FL@2 counts from the later of execution and delivery. Falling back to
    // execution alone would start the clock early whenever delivery came second.
    let message = "";
    try {
      computeRescissionDeadline({ stateCode: "FL", contractExecutedAt: "2026-03-05T14:00:00.000Z" }, base);
    } catch (error) {
      if (!isDenied(error)) throw error;
      message = error.message;
    }
    expect(message).toContain("documentsDeliveredAt");
    expect(message).toContain("later");
  });

  it("refuses when the rule counts from delivery and delivery is unknown", () => {
    expect(
      denialReason(() =>
        computeRescissionDeadline({ stateCode: "HI", contractExecutedAt: "2026-03-05T14:00:00.000Z" }, base),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses an unparseable trigger instant rather than guessing a zone for it", () => {
    expect(
      denialReason(() =>
        computeRescissionDeadline({ stateCode: "FL", contractExecutedAt: "2026-03-05T14:00:00" }, base),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses when no rule version was in effect on the contract's date", () => {
    expect(
      denialReason(() =>
        computeRescissionDeadline({ stateCode: "FL", contractExecutedAt: "1995-06-01T14:00:00.000Z" }, base),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses when two rule versions both cover the contract's date", () => {
    // Which law governs is then unanswerable, and picking one silently would be
    // a legal decision made by an ordering accident.
    const overlapping = tableOf(
      rule({ version: "ZZ@1", effectiveFrom: "2000-01-01", effectiveTo: "2026-12-31" }),
      rule({ version: "ZZ@2", effectiveFrom: "2026-01-01", effectiveTo: null }),
    );
    let message = "";
    try {
      computeRescissionDeadline(
        { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" },
        { ...base, rules: overlapping },
      );
    } catch (error) {
      if (!isDenied(error)) throw error;
      message = error.message;
    }
    expect(message).toContain("ZZ@1, ZZ@2");
  });

  it("refuses when the rule's holiday calendar is not loaded", () => {
    // Silently counting without it would treat every holiday as a business day.
    const table = tableOf(rule({ basis: "business_days", holidayCalendarId: "US-NOWHERE" }));
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" },
          { ...base, rules: table },
        ),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses a rule row whose timezone the runtime cannot resolve", () => {
    // Bad rule data must surface as a refusal, not as a validation error a
    // caller could catch narrowly and carry on from.
    const table = tableOf(rule({ timeZone: "US/Eastern-ish" }));
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" },
          { ...base, rules: table },
        ),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses a rule row whose effective date is not a real date", () => {
    const table = tableOf(rule({ effectiveFrom: "2026-02-30" }));
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" },
          { ...base, rules: table },
        ),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses when the roll cannot find a business day to land on", () => {
    const shutForever: HolidayCalendar = {
      id: "TEST-CLOSED",
      label: "Permanently closed",
      verified: false,
      reviewRequired: "test fixture",
      holidays: Array.from({ length: 60 }, (_, offset) => ({
        id: `test.day_${offset}`,
        name: "Closed",
        definition: {
          kind: "explicit_dates" as const,
          dates: [formatCivilDate(addDays({ year: 2026, month: 3, day: 1 }, offset))],
        },
        verified: false,
      })),
    };
    const table = tableOf(
      rule({ windowLength: 3, roll: "next_business_day", holidayCalendarId: "TEST-CLOSED" }),
    );
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" },
          { ...base, rules: table, holidayCalendars: new Map([["TEST-CLOSED", shutForever]]) },
        ),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses rather than looping when no day in the calendar can ever count", () => {
    const table = tableOf(
      rule({ basis: "business_days", weekendDays: [0, 1, 2, 3, 4, 5, 6] }),
    );
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" },
          { ...base, rules: table },
        ),
      ),
    ).toBe("knowledge.no_grounding");
  });
});

describe("unverified rules", () => {
  it("refuses to compute from an unverified rule when the deployment forbids it", () => {
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          {
            stateCode: "FL",
            contractExecutedAt: "2026-03-05T14:00:00.000Z",
            documentsDeliveredAt: "2026-03-05T14:00:00.000Z",
          },
          { ...base, requireVerifiedRules: true },
        ),
      ),
    ).toBe("knowledge.stale_authority");
  });

  it("computes from a verified rule under the same setting", () => {
    // Proves the control gates on verification rather than simply denying.
    const verified = tableOf(
      rule({
        verified: true,
        citation: "Test Jurisdiction Code, chapter 1, section 2 (synthetic fixture)",
        sourceUrl: "https://example.test/statute",
      }),
    );
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" },
      { ...base, rules: verified, requireVerifiedRules: true },
    );
    expect(result.ruleVerified).toBe(true);
    expect(result.warnings.some((warning) => warning.startsWith("Rule version"))).toBe(false);
  });
});

describe("effective dating", () => {
  const table = tableOf(
    rule({
      version: "ZZ@1",
      windowLength: 5,
      effectiveFrom: "2000-01-01",
      effectiveTo: "2019-12-31",
    }),
    rule({
      version: "ZZ@2",
      windowLength: 10,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
    }),
  );

  it("applies the rule that was in force when the older contract was formed", () => {
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2015-06-01T14:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(result.ruleVersion).toBe("ZZ@1");
    expect(result.windowApplied).toBe(5);
    // Counting starts 2015-06-02; the fifth calendar day is 2015-06-06.
    expect(result.deadlineLocalDate).toBe("2015-06-06");
  });

  it("applies the current rule to a current contract", () => {
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-06-01T14:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(result.ruleVersion).toBe("ZZ@2");
    expect(result.windowApplied).toBe(10);
  });

  it("switches versions exactly at the local boundary, not at UTC midnight", () => {
    // 2020-01-01T02:00Z is still 2019-12-31 in New York, so the older version
    // still governs. A UTC-boundary comparison would apply the new statute to a
    // contract signed the evening before it took effect.
    const lateOnTheLastEvening = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2020-01-01T02:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(lateOnTheLastEvening.ruleVersion).toBe("ZZ@1");

    const firstMorning = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2020-01-01T14:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(firstMorning.ruleVersion).toBe("ZZ@2");
  });

  it("selects the governing version from execution even when the clock starts on delivery", () => {
    // Which law governs is fixed at formation; when the clock starts is a
    // separate question the selected version answers.
    const laterOf = tableOf(
      rule({
        version: "ZZ@1",
        trigger: "later_of_execution_or_delivery",
        effectiveFrom: "2000-01-01",
        effectiveTo: "2019-12-31",
        windowLength: 5,
      }),
      rule({
        version: "ZZ@2",
        trigger: "later_of_execution_or_delivery",
        effectiveFrom: "2020-01-01",
        effectiveTo: null,
        windowLength: 10,
      }),
    );
    const result = computeRescissionDeadline(
      {
        stateCode: "ZZ",
        contractExecutedAt: "2019-12-20T14:00:00.000Z",
        documentsDeliveredAt: "2020-01-15T14:00:00.000Z",
      },
      { ...base, rules: laterOf },
    );
    expect(result.ruleVersion).toBe("ZZ@1");
    expect(result.triggerInstant).toBe("2020-01-15T14:00:00.000Z");
  });
});

describe("daylight saving transitions", () => {
  const threeDay = tableOf(rule({ windowLength: 3, basis: "calendar_days", roll: "none" }));
  const options = { ...base, rules: threeDay };

  it("keeps a three-day window three calendar days long across spring forward", () => {
    // Clocks jump forward on 2026-03-08 in New York.
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" },
      options,
    );
    expect(result.countingStartDate).toBe("2026-03-06");
    expect(result.deadlineLocalDate).toBe("2026-03-08");
    expect(result.deadlineLocalTime).toBe("23:59:59.999");
    expect(result.deadlineInstant).toBe("2026-03-09T03:59:59.999Z");
    // The offset changed mid-window, which is exactly what naive arithmetic misses.
    expect(result.utcOffsetAtDeadline).toBe("-04:00");
  });

  it("spends 71 real hours doing it, and that is correct", () => {
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" },
      options,
    );
    const startOfFirstCountedDay = Date.parse("2026-03-06T05:00:00.000Z"); // local midnight, EST
    const elapsedHours =
      (Date.parse(result.deadlineInstant) + 1 - startOfFirstCountedDay) / 3_600_000;
    expect(elapsedHours).toBe(71);

    // What a fixed 72-hour addition would have produced instead: an instant an
    // hour past the end of the third day, landing the deadline on 2026-03-09
    // local and handing out a fourth day.
    const naive = startOfFirstCountedDay + 3 * 86_400_000 - 1;
    expect(naive - Date.parse(result.deadlineInstant)).toBe(3_600_000);
  });

  it("keeps a three-day window three calendar days long across fall back", () => {
    // Clocks go back on 2026-11-01 in New York.
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-10-29T14:00:00.000Z" },
      options,
    );
    expect(result.deadlineLocalDate).toBe("2026-11-01");
    expect(result.deadlineInstant).toBe("2026-11-02T04:59:59.999Z");
    expect(result.utcOffsetAtDeadline).toBe("-05:00");

    const startOfFirstCountedDay = Date.parse("2026-10-30T04:00:00.000Z"); // local midnight, EDT
    const elapsedHours =
      (Date.parse(result.deadlineInstant) + 1 - startOfFirstCountedDay) / 3_600_000;
    expect(elapsedHours).toBe(73);

    // Naive 72-hour arithmetic would have closed the window an hour early, at
    // 22:59:59 local — rejecting a cancellation that arrived at 23:30 on the
    // final day.
    const naive = startOfFirstCountedDay + 3 * 86_400_000 - 1;
    expect(Date.parse(result.deadlineInstant) - naive).toBe(3_600_000);
  });

  it("records how a deadline landing in the ambiguous hour was resolved", () => {
    // A jurisdiction whose window closes at 01:30 local — an hour that happens
    // twice on the fall-back date.
    const oddHour = tableOf(
      rule({
        windowLength: 3,
        endOfDay: { hour: 1, minute: 30, second: 0, millisecond: 0 },
      }),
    );
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-10-29T14:00:00.000Z" },
      { ...base, rules: oddHour },
    );
    expect(result.deadlineLocalDate).toBe("2026-11-01");
    expect(result.zoneResolution).toBe("ambiguous_later");
    expect(result.deadlineInstant).toBe("2026-11-01T06:30:00.000Z");
    expect(result.warnings.join(" ")).toContain("occurs twice");
  });

  it("records how a deadline landing in the spring-forward gap was resolved", () => {
    const oddHour = tableOf(
      rule({
        windowLength: 3,
        endOfDay: { hour: 2, minute: 30, second: 0, millisecond: 0 },
      }),
    );
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" },
      { ...base, rules: oddHour },
    );
    expect(result.deadlineLocalDate).toBe("2026-03-08");
    expect(result.zoneResolution).toBe("nonexistent_shifted");
    expect(result.deadlineInstant).toBe("2026-03-08T07:30:00.000Z");
    expect(result.warnings.join(" ")).toContain("does not exist");
  });
});

describe("counting bases and rolls", () => {
  it("counts business days, skipping weekends and observed holidays", () => {
    // Trigger on Wednesday 2026-11-25; Thursday is the observed holiday.
    const table = tableOf(
      rule({ windowLength: 3, basis: "business_days", holidayCalendarId: "US-ZZ", roll: "none" }),
    );
    const calendars: HolidayCalendarTable = new Map([
      ...HOLIDAY_CALENDARS,
      ["US-ZZ", jurisdictionCalendar("ZZ")],
    ]);
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-11-25T15:00:00.000Z" },
      { ...base, rules: table, holidayCalendars: calendars },
    );
    expect(result.countingStartDate).toBe("2026-11-26");
    expect(result.deadlineLocalDate).toBe("2026-12-01");
    expect(result.uncountedDays.map((d) => d.date)).toEqual(["2026-11-26", "2026-11-28", "2026-11-29"]);
    expect(result.uncountedDays[0]?.reason).toContain("observed holiday");
    expect(result.uncountedDays[1]?.reason).toContain("weekend");
  });

  it("counts calendar days straight through weekends and holidays", () => {
    const table = tableOf(rule({ windowLength: 3, basis: "calendar_days", roll: "none" }));
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-11-25T15:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(result.deadlineLocalDate).toBe("2026-11-28");
    expect(result.uncountedDays).toEqual([]);
  });

  it("leaves a weekend deadline where it falls when the rule does not roll", () => {
    const table = tableOf(rule({ windowLength: 3, roll: "none" }));
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-11-25T15:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(result.deadlineLocalDate).toBe("2026-11-28"); // a Saturday
    expect(result.rawDeadlineDate).toBe(result.deadlineLocalDate);
    expect(result.steps.some((s) => s.label === "roll.not_applied")).toBe(true);
  });

  it("rolls a weekend deadline forward when the rule says to", () => {
    const table = tableOf(rule({ windowLength: 3, roll: "next_business_day" }));
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-11-25T15:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(result.rawDeadlineDate).toBe("2026-11-28");
    expect(result.deadlineLocalDate).toBe("2026-11-30");
  });

  it("rolls a deadline that lands on a holiday, not only one on a weekend", () => {
    const table = tableOf(
      rule({ windowLength: 1, roll: "next_business_day", holidayCalendarId: "US-ZZ" }),
    );
    const calendars: HolidayCalendarTable = new Map([
      ...HOLIDAY_CALENDARS,
      ["US-ZZ", jurisdictionCalendar("ZZ")],
    ]);
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-11-25T15:00:00.000Z" },
      { ...base, rules: table, holidayCalendars: calendars },
    );
    // The count lands on the observed holiday; the roll clears it.
    expect(result.rawDeadlineDate).toBe("2026-11-26");
    expect(result.deadlineLocalDate).toBe("2026-11-27");
    expect(result.uncountedDays.some((d) => d.reason.includes("rolled forward"))).toBe(true);
  });

  it("counts the trigger day itself when the rule says so", () => {
    const table = tableOf(rule({ windowLength: 3, countingStart: "trigger_day" }));
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-06-01T14:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(result.countingStartDate).toBe("2026-06-01");
    expect(result.deadlineLocalDate).toBe("2026-06-03");
  });

  it("crosses month and year boundaries", () => {
    const table = tableOf(rule({ windowLength: 10 }));
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-12-28T14:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(result.deadlineLocalDate).toBe("2027-01-07");
  });

  it("counts through a leap day", () => {
    const table = tableOf(rule({ windowLength: 3 }));
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2028-02-26T14:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(result.deadlineLocalDate).toBe("2028-02-29");
  });

  it("puts the trigger on the local date, not the UTC date", () => {
    // 03:00Z on 2026-06-02 is still the evening of 2026-06-01 in New York, so
    // the clock starts a day earlier than a UTC reading would suggest.
    const table = tableOf(rule({ windowLength: 3 }));
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-06-02T03:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(result.triggerLocalDate).toBe("2026-06-01");
    expect(result.deadlineLocalDate).toBe("2026-06-04");
  });
});

describe("tolling", () => {
  const table = tableOf(rule({ windowLength: 3, roll: "none" }));
  const options = { ...base, rules: table };
  const input = { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" };

  it("does not count days on which the clock was suspended", () => {
    const result = computeRescissionDeadline(
      {
        ...input,
        tollingEvents: [
          tollingEvent({ effectiveAt: "2026-03-06T12:00:00.000Z", endsAt: "2026-03-07T12:00:00.000Z" }),
        ],
      },
      options,
    );
    // Without tolling the deadline is 2026-03-08; two suspended days push it out.
    expect(result.deadlineLocalDate).toBe("2026-03-10");
    expect(result.uncountedDays.map((d) => d.date)).toEqual(["2026-03-06", "2026-03-07"]);
    expect(result.tollingApplied[0]?.effect).toContain("suspended for 2 local day(s)");
    expect(result.tollingApplied[0]?.reason.length).toBeGreaterThan(0);
    expect(result.tollingApplied[0]?.authority.length).toBeGreaterThan(0);
  });

  it("restarts the clock from a new trigger, discarding days already counted", () => {
    const result = computeRescissionDeadline(
      {
        ...input,
        tollingEvents: [
          tollingEvent({
            kind: "restart",
            code: "disclosure_defect_cured",
            effectiveAt: "2026-03-20T14:00:00.000Z",
            endsAt: undefined,
          }),
        ],
      },
      options,
    );
    expect(result.triggerInstant).toBe("2026-03-20T14:00:00.000Z");
    expect(result.countingStartDate).toBe("2026-03-21");
    expect(result.deadlineLocalDate).toBe("2026-03-23");
  });

  it("takes the latest restart when several are recorded", () => {
    const result = computeRescissionDeadline(
      {
        ...input,
        tollingEvents: [
          tollingEvent({ kind: "restart", effectiveAt: "2026-03-20T14:00:00.000Z", endsAt: undefined }),
          tollingEvent({ kind: "restart", effectiveAt: "2026-03-25T14:00:00.000Z", endsAt: undefined }),
        ],
      },
      options,
    );
    expect(result.triggerInstant).toBe("2026-03-25T14:00:00.000Z");
  });

  it("lengthens the window without moving the trigger", () => {
    const result = computeRescissionDeadline(
      {
        ...input,
        tollingEvents: [
          tollingEvent({
            kind: "extend",
            code: "agreed_extension",
            extendByDays: 4,
            endsAt: undefined,
          }),
        ],
      },
      options,
    );
    expect(result.windowLength).toBe(3);
    expect(result.windowApplied).toBe(7);
    expect(result.triggerInstant).toBe("2026-03-05T14:00:00.000Z");
    expect(result.deadlineLocalDate).toBe("2026-03-12");
  });

  it("produces the same deadline whatever order the events were stored in", () => {
    const events: readonly TollingEvent[] = [
      tollingEvent({ effectiveAt: "2026-03-06T12:00:00.000Z", endsAt: "2026-03-06T18:00:00.000Z" }),
      tollingEvent({ kind: "extend", extendByDays: 2, endsAt: undefined, effectiveAt: "2026-03-07T12:00:00.000Z" }),
      tollingEvent({ effectiveAt: "2026-03-09T12:00:00.000Z", endsAt: "2026-03-09T18:00:00.000Z" }),
    ];
    const forwards = computeRescissionDeadline({ ...input, tollingEvents: events }, options);
    const backwards = computeRescissionDeadline(
      { ...input, tollingEvents: [...events].reverse() },
      options,
    );
    expect(backwards.deadlineInstant).toBe(forwards.deadlineInstant);
    expect(deadlineFingerprint(backwards)).toBe(deadlineFingerprint(forwards));
  });

  it("refuses a suspension with no end", () => {
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          { ...input, tollingEvents: [tollingEvent({ endsAt: undefined })] },
          options,
        ),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses a suspension that ends before it starts", () => {
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          {
            ...input,
            tollingEvents: [
              tollingEvent({ effectiveAt: "2026-03-10T12:00:00.000Z", endsAt: "2026-03-08T12:00:00.000Z" }),
            ],
          },
          options,
        ),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses a suspension long enough to disable the deadline entirely", () => {
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          {
            ...input,
            tollingEvents: [
              tollingEvent({ effectiveAt: "2026-03-06T12:00:00.000Z", endsAt: "2030-03-06T12:00:00.000Z" }),
            ],
          },
          options,
        ),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses a restart that moves the trigger backwards", () => {
    // Moving the trigger earlier would shorten the consumer's window.
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          {
            ...input,
            tollingEvents: [
              tollingEvent({
                kind: "restart",
                effectiveAt: "2026-02-01T14:00:00.000Z",
                endsAt: undefined,
              }),
            ],
          },
          options,
        ),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses an extension past the per-event bound", () => {
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          {
            ...input,
            tollingEvents: [
              tollingEvent({ kind: "extend", extendByDays: MAX_TOLLING_DAYS + 1, endsAt: undefined }),
            ],
          },
          options,
        ),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses small extensions stacked to evade the per-event bound", () => {
    // The bound has to hold on the total, or padding one field defeats it.
    const many = Array.from({ length: 40 }, (_, index) =>
      tollingEvent({
        kind: "extend",
        extendByDays: 10,
        endsAt: undefined,
        effectiveAt: `2026-03-${String(6 + (index % 20)).padStart(2, "0")}T12:00:00.000Z`,
      }),
    );
    expect(
      denialReason(() => computeRescissionDeadline({ ...input, tollingEvents: many }, options)),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses an implausible number of tolling events", () => {
    const many = Array.from({ length: 60 }, () => tollingEvent());
    expect(
      denialReason(() => computeRescissionDeadline({ ...input, tollingEvents: many }, options)),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses an extension that is not a positive whole number of days", () => {
    for (const days of [0, -5, 1.5, Number.NaN]) {
      expect(
        denialReason(() =>
          computeRescissionDeadline(
            {
              ...input,
              tollingEvents: [tollingEvent({ kind: "extend", extendByDays: days, endsAt: undefined })],
            },
            options,
          ),
        ),
      ).toBe("knowledge.no_grounding");
    }
  });

  it("refuses a tolling event with no stated reason or no authority", () => {
    expect(
      denialReason(() =>
        computeRescissionDeadline({ ...input, tollingEvents: [tollingEvent({ reason: "  " })] }, options),
      ),
    ).toBe("knowledge.no_grounding");
    expect(
      denialReason(() =>
        computeRescissionDeadline({ ...input, tollingEvents: [tollingEvent({ authority: "" })] }, options),
      ),
    ).toBe("knowledge.no_grounding");
  });

  it("refuses a malformed tolling instant rather than skipping the event", () => {
    // Skipping it would silently produce the untolled — shorter — deadline.
    expect(
      denialReason(() =>
        computeRescissionDeadline(
          { ...input, tollingEvents: [tollingEvent({ effectiveAt: "March 6th" })] },
          options,
        ),
      ),
    ).toBe("knowledge.no_grounding");
  });
});

describe("reproducibility and the audit surface", () => {
  const input = {
    stateCode: "FL",
    contractExecutedAt: "2026-03-05T14:00:00.000Z",
    documentsDeliveredAt: "2026-03-06T09:30:00.000Z",
  };

  it("produces a byte-identical derivation on every run", () => {
    const first = computeRescissionDeadline(input, base);
    const second = computeRescissionDeadline(input, base);
    expect(canonicalJson(second)).toBe(canonicalJson(first));
  });

  it("fingerprints the facts that determine the answer, not the prose or the timestamp", () => {
    const early = computeRescissionDeadline(input, { clock: new FixedClock("2026-08-01T00:00:00Z") });
    const late = computeRescissionDeadline(input, { clock: new FixedClock("2027-01-01T00:00:00Z") });
    expect(early.computedAt).not.toBe(late.computedAt);
    expect(deadlineFingerprint(late)).toBe(deadlineFingerprint(early));
  });

  it("changes the fingerprint when the governing rule version changes", () => {
    const table = tableOf(
      rule({ version: "ZZ@1", windowLength: 5, effectiveFrom: "2000-01-01", effectiveTo: "2019-12-31" }),
      rule({ version: "ZZ@2", windowLength: 5, effectiveFrom: "2020-01-01", effectiveTo: null }),
    );
    const older = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2015-06-01T14:00:00.000Z" },
      { ...base, rules: table },
    );
    const newer = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-06-01T14:00:00.000Z" },
      { ...base, rules: table },
    );
    expect(deadlineFingerprint(newer)).not.toBe(deadlineFingerprint(older));
  });

  it("carries no owner personal data into anything an audit record would hold", () => {
    const result = computeRescissionDeadline(input, base);
    const serialised = canonicalJson({
      fingerprint: deadlineFingerprint(result),
      jurisdiction: result.jurisdiction,
      version: result.ruleVersion,
      steps: result.steps,
    });
    expect(serialised).not.toMatch(/\d{3}-\d{2}-\d{4}/); // no SSN shapes
    expect(serialised).not.toMatch(/\b\d{13,19}\b/); // no card-number shapes
  });
});

describe("deciding whether a cancellation was timely", () => {
  const result = computeRescissionDeadline(
    {
      stateCode: "FL",
      contractExecutedAt: "2026-03-05T14:00:00.000Z",
      documentsDeliveredAt: "2026-03-05T14:00:00.000Z",
    },
    base,
  );

  it("accepts a cancellation at the last representable instant of the window", () => {
    expect(isWithinRescissionWindow(result, result.deadlineInstant)).toBe(true);
  });

  it("rejects one that arrives a millisecond later", () => {
    const late = new Date(Date.parse(result.deadlineInstant) + 1).toISOString();
    expect(isWithinRescissionWindow(result, late)).toBe(false);
  });

  it("accepts one that arrives well inside the window", () => {
    expect(isWithinRescissionWindow(result, "2026-03-10T09:00:00.000Z")).toBe(true);
  });
});

describe("the derivation is legible on its own", () => {
  it("names the rule version, the citation, the timezone, and every skipped day", () => {
    const calendars: HolidayCalendarTable = new Map([
      ...HOLIDAY_CALENDARS,
      ["US-ZZ", jurisdictionCalendar("ZZ")],
    ]);
    const table = tableOf(
      rule({ windowLength: 3, basis: "business_days", holidayCalendarId: "US-ZZ" }),
    );
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-11-25T15:00:00.000Z" },
      { ...base, rules: table, holidayCalendars: calendars },
    );
    const prose = result.steps.map((s) => s.detail).join("\n");
    expect(prose).toContain("ZZ@1");
    expect(prose).toContain(PLACEHOLDER_MARKER);
    expect(prose).toContain("America/New_York");
    expect(prose).toContain("business day");
    expect(result.uncountedDays.length).toBe(3);
  });

  it("keeps the uncounted-day list bounded and says when it truncated it", () => {
    // A long suspension produces many uncounted days; the record must stay a
    // reviewable size rather than growing without limit.
    const calendars: HolidayCalendarTable = new Map(HOLIDAY_CALENDARS);
    const table = tableOf(rule({ windowLength: 3 }));
    const start = { year: 2026, month: 3, day: 6 };
    const events: TollingEvent[] = [
      tollingEvent({
        effectiveAt: "2026-03-06T12:00:00.000Z",
        endsAt: `${formatCivilDate(addDays(start, 200))}T12:00:00.000Z`,
      }),
    ];
    const result = computeRescissionDeadline(
      { stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z", tollingEvents: events },
      { ...base, rules: table, holidayCalendars: calendars },
    );
    expect(result.uncountedDays.length).toBeLessThanOrEqual(60);
    expect(result.warnings.join(" ")).toContain("truncated");
  });
});

describe("denials are the platform's refusal type", () => {
  it("throws DeniedError with a machine-readable reason a caller can route on", () => {
    let caught: unknown;
    try {
      computeRescissionDeadline({ stateCode: "ZZ", contractExecutedAt: "2026-03-05T14:00:00.000Z" }, base);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeniedError);
    expect((caught as DeniedError).reason).toBe("knowledge.no_grounding");
    expect((caught as DeniedError).detail.stateCode).toBe("ZZ");
  });
});
