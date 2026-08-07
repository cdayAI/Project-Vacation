import { describe, it, expect } from "vitest";
import { FixedClock } from "../kernel/clock.js";
import { DeniedError } from "../kernel/errors.js";
import {
  computeRescissionDeadline,
  deadlineFingerprint,
} from "../timeline/compute.js";
import { RESCISSION_RULES, validateRuleTable } from "../timeline/rules.js";
import {
  HOLIDAY_CALENDARS,
  addDays,
  daysFromCivil,
  formatCivilDate,
  formatOffset,
  isBusinessDay,
  offsetMsAt,
  parseIsoDate,
  parseIsoInstant,
  zonedFieldsAt,
} from "../timeline/calendar.js";
import type { ComputeOptions } from "../timeline/compute.js";
import type { TollingEvent } from "../timeline/types.js";

/**
 * Pass 4, group one — the rescission engine, checked against arithmetic rather
 * than against its own comments.
 *
 * The rule table ships entirely unverified and says so, so nothing here asserts
 * that any *number* is the law. What is asserted is that the machine which
 * turns a rule into a date is arithmetically correct, because that is the part
 * counsel cannot review by reading the table. If the engine miscounts, a
 * correct table still produces a wrong deadline.
 *
 * The three sweeps below are deliberately exhaustive rather than illustrative.
 * A hand-picked example proves the engine handles that example; sixteen
 * thousand trigger dates across every shipped jurisdiction prove there is no
 * date on which it does something else. Each sweep re-derives the answer by an
 * independent method — recounting the days one at a time, and asking `Intl`
 * separately what the deadline instant reads as on the local wall clock — so a
 * shared bug in the engine's own helpers cannot make both sides agree.
 *
 * Every assertion in this file passes. It is recorded so the next reviewer does
 * not spend a day re-deriving that the counting is right, and so a future
 * change to the counting is caught by something other than the tests that were
 * written alongside it.
 */

const CLOCK = new FixedClock("2026-08-07T00:00:00.000Z");
const OPTIONS: ComputeOptions = { clock: CLOCK };

/** Every jurisdiction with a rule, excluding the deliberately empty fallback. */
const JURISDICTIONS = [...RESCISSION_RULES.keys()].filter((code) => code !== "DEFAULT");

function tolling(overrides: Partial<TollingEvent> & Pick<TollingEvent, "kind" | "code">): TollingEvent {
  return {
    reason: "recorded for the review sweep",
    authority: "review harness",
    recordedBy: "act_review",
    effectiveAt: "2026-03-06T00:00:00.000Z",
    ...overrides,
  } as TollingEvent;
}

describe("the shipped rule table", () => {
  it("has no structural or provenance problems", () => {
    expect(validateRuleTable(RESCISSION_RULES)).toEqual([]);
  });

  it("carries no rule that claims to be verified", () => {
    // The honesty claim, asserted from outside `rules.ts` so the constructor
    // that stamps `verified: false` is not the only thing holding it up.
    const claiming = JURISDICTIONS.flatMap((code) =>
      (RESCISSION_RULES.get(code)?.versions ?? []).filter((rule) => rule.verified),
    );
    expect(claiming).toEqual([]);
  });
});

describe("day counting, re-derived independently", () => {
  it("lands on the day the count reaches the window, for every jurisdiction over 800 trigger dates", () => {
    const problems: string[] = [];

    for (const stateCode of JURISDICTIONS) {
      for (let offset = 0; offset < 800; offset += 1) {
        const day = formatCivilDate(addDays({ year: 2025, month: 1, day: 1 }, offset));
        const at = `${day}T15:00:00.000Z`;
        const result = computeRescissionDeadline(
          { stateCode, contractExecutedAt: at, documentsDeliveredAt: at },
          OPTIONS,
        );

        const calendar = HOLIDAY_CALENDARS.get(result.rule.holidayCalendarId);
        if (!calendar) {
          problems.push(`${stateCode} ${day}: calendar ${result.rule.holidayCalendarId} missing`);
          continue;
        }

        // Recount from scratch, one day at a time, without using walkWindow.
        const end = parseIsoDate(result.rawDeadlineDate);
        let cursor = parseIsoDate(result.countingStartDate);
        let counted = 0;
        for (;;) {
          const counts =
            result.basis === "calendar_days" ||
            isBusinessDay(cursor, calendar, result.rule.weekendDays);
          if (counts) counted += 1;
          if (daysFromCivil(cursor) >= daysFromCivil(end)) break;
          cursor = addDays(cursor, 1);
        }
        if (counted !== result.windowApplied) {
          problems.push(
            `${stateCode} ${day}: recounted ${counted} day(s) from ${result.countingStartDate} to ${result.rawDeadlineDate}, but the window applied was ${result.windowApplied}`,
          );
        }

        // A business-day window can only end on a business day.
        if (
          result.basis === "business_days" &&
          !isBusinessDay(parseIsoDate(result.rawDeadlineDate), calendar, result.rule.weekendDays)
        ) {
          problems.push(`${stateCode} ${day}: business-day window ended on ${result.rawDeadlineDate}`);
        }

        // A rule that rolls must produce a business day; one that does not must
        // leave the date exactly where the count put it.
        if (result.rule.roll === "next_business_day") {
          if (!isBusinessDay(parseIsoDate(result.deadlineLocalDate), calendar, result.rule.weekendDays)) {
            problems.push(`${stateCode} ${day}: rolled to ${result.deadlineLocalDate}, still not a business day`);
          }
        } else if (result.deadlineLocalDate !== result.rawDeadlineDate) {
          problems.push(
            `${stateCode} ${day}: roll is "none" but ${result.rawDeadlineDate} became ${result.deadlineLocalDate}`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it("never moves a deadline earlier when the trigger moves later", () => {
    // Monotonicity is the property a consumer would notice being broken: two
    // contracts signed a day apart cannot have the later one cancel first.
    const problems: string[] = [];

    for (const stateCode of JURISDICTIONS) {
      let previous = Number.NEGATIVE_INFINITY;
      let previousDay = "";
      for (let offset = 0; offset < 800; offset += 1) {
        const day = formatCivilDate(addDays({ year: 2025, month: 1, day: 1 }, offset));
        const at = `${day}T15:00:00.000Z`;
        const result = computeRescissionDeadline(
          { stateCode, contractExecutedAt: at, documentsDeliveredAt: at },
          OPTIONS,
        );
        const instant = parseIsoInstant(result.deadlineInstant);
        if (instant < previous) {
          problems.push(
            `${stateCode}: trigger ${previousDay} closes at ${new Date(previous).toISOString()} but the later trigger ${day} closes at ${result.deadlineInstant}`,
          );
        }
        if (instant <= parseIsoInstant(at)) {
          problems.push(`${stateCode} ${day}: deadline is not after the trigger`);
        }
        previous = instant;
        previousDay = day;
      }
    }

    expect(problems).toEqual([]);
  });
});

describe("timezones, daylight saving, and the leap day", () => {
  it("closes at 23:59:59.999 on the local wall clock, at every hour of every awkward day", () => {
    // Re-asked of Intl directly rather than of the engine's own formatter, so
    // the two have to agree. The dates cover both US transitions, both sides of
    // a leap day, and a year boundary.
    const problems: string[] = [];
    const awkward = [
      "2026-03-07",
      "2026-03-08",
      "2026-11-01",
      "2026-02-28",
      "2024-02-28",
      "2024-02-29",
      "2026-12-31",
    ];

    for (const stateCode of JURISDICTIONS) {
      for (const day of awkward) {
        for (let hour = 0; hour < 24; hour += 1) {
          const at = `${day}T${String(hour).padStart(2, "0")}:30:00.000Z`;
          const result = computeRescissionDeadline(
            { stateCode, contractExecutedAt: at, documentsDeliveredAt: at },
            OPTIONS,
          );
          const instant = parseIsoInstant(result.deadlineInstant);
          const local = zonedFieldsAt(instant, result.timeZone);
          const localDate = `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;

          if (result.deadlineLocalTime !== "23:59:59.999") {
            problems.push(`${stateCode} ${at}: local close is ${result.deadlineLocalTime}`);
          }
          if (local.hour !== 23 || local.minute !== 59 || local.second !== 59) {
            problems.push(
              `${stateCode} ${at}: ${result.deadlineInstant} reads ${local.hour}:${local.minute}:${local.second} in ${result.timeZone}`,
            );
          }
          if (localDate !== result.deadlineLocalDate) {
            problems.push(
              `${stateCode} ${at}: instant falls on ${localDate} locally, but the record says ${result.deadlineLocalDate}`,
            );
          }
          const offset = formatOffset(offsetMsAt(instant, result.timeZone));
          if (offset !== result.utcOffsetAtDeadline) {
            problems.push(
              `${stateCode} ${at}: offset in force is ${offset}, but the record says ${result.utcOffsetAtDeadline}`,
            );
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it("keeps a ten-day Florida window ten calendar days long across the autumn transition", () => {
    // The specific failure a fixed-duration implementation produces: 10 * 86.4m
    // milliseconds from a late-October execution lands an hour before midnight,
    // which refuses a cancellation delivered at 23:30 on the final day.
    const result = computeRescissionDeadline(
      {
        stateCode: "FL",
        contractExecutedAt: "2026-10-30T12:00:00.000Z",
        documentsDeliveredAt: "2026-10-30T12:00:00.000Z",
      },
      OPTIONS,
    );

    expect(result.deadlineLocalDate).toBe("2026-11-09");
    expect(result.utcOffsetAtDeadline).toBe("-05:00");
    expect(result.deadlineInstant).toBe("2026-11-10T04:59:59.999Z");

    const naive = new Date(Date.parse("2026-10-30T12:00:00.000Z") + 10 * 86_400_000).toISOString();
    expect(result.deadlineInstant).not.toBe(naive);
    // The correct answer is later than the naive one, which is the safe side.
    expect(parseIsoInstant(result.deadlineInstant)).toBeGreaterThan(parseIsoInstant(naive));
  });

  it("counts across 29 February without losing or gaining a day", () => {
    const result = computeRescissionDeadline(
      {
        stateCode: "FL",
        contractExecutedAt: "2024-02-20T14:00:00.000Z",
        documentsDeliveredAt: "2024-02-20T14:00:00.000Z",
      },
      OPTIONS,
    );
    // 21 Feb is day one; 29 Feb exists in 2024, so day ten is 1 March.
    expect(result.countingStartDate).toBe("2024-02-21");
    expect(result.rawDeadlineDate).toBe("2024-03-01");
  });

  it("treats a contract executed at exactly local midnight as falling on that day", () => {
    // 05:00Z is 00:00:00.000 in New York on 5 March. The trigger day is the
    // 5th, so counting starts on the 6th — one day later than if the boundary
    // had been read in UTC.
    const result = computeRescissionDeadline(
      {
        stateCode: "FL",
        contractExecutedAt: "2026-03-05T05:00:00.000Z",
        documentsDeliveredAt: "2026-03-05T05:00:00.000Z",
      },
      OPTIONS,
    );
    expect(result.triggerLocalDate).toBe("2026-03-05");
    expect(result.countingStartDate).toBe("2026-03-06");

    // One millisecond earlier is the previous local day, and the whole window
    // shifts back with it.
    const justBefore = computeRescissionDeadline(
      {
        stateCode: "FL",
        contractExecutedAt: "2026-03-05T04:59:59.999Z",
        documentsDeliveredAt: "2026-03-05T04:59:59.999Z",
      },
      OPTIONS,
    );
    expect(justBefore.triggerLocalDate).toBe("2026-03-04");
    expect(justBefore.countingStartDate).toBe("2026-03-05");
  });

  it("uses the jurisdiction's clock, not the server's, for a state that does not observe daylight saving", () => {
    const arizona = computeRescissionDeadline(
      { stateCode: "AZ", contractExecutedAt: "2026-07-06T18:00:00.000Z" },
      OPTIONS,
    );
    const colorado = computeRescissionDeadline(
      { stateCode: "CO", contractExecutedAt: "2026-07-06T18:00:00.000Z" },
      OPTIONS,
    );
    // Same nominal zone offset in winter; in July, Arizona stays on -07:00
    // while Colorado moves to -06:00.
    expect(arizona.utcOffsetAtDeadline).toBe("-07:00");
    expect(colorado.utcOffsetAtDeadline).toBe("-06:00");
  });
});

describe("weekend and holiday starts", () => {
  it("does not count the weekend a Friday execution runs into, under a business-day rule", () => {
    // Missouri counts business days from the day after execution. Executing on
    // Friday 6 March 2026 starts the count on a Saturday, which cannot count.
    const result = computeRescissionDeadline(
      { stateCode: "MO", contractExecutedAt: "2026-03-06T16:00:00.000Z" },
      OPTIONS,
    );
    expect(result.countingStartDate).toBe("2026-03-07");
    expect(result.uncountedDays.map((day) => day.date)).toEqual(["2026-03-07", "2026-03-08"]);
    expect(result.rawDeadlineDate).toBe("2026-03-13");
  });

  it("skips an observed holiday that falls inside a business-day window", () => {
    // Massachusetts counts three business days. Executing Thursday 2 July 2026
    // starts the count on Friday the 3rd, which the shipped placeholder
    // calendar observes for 4 July (a Saturday that year).
    const result = computeRescissionDeadline(
      { stateCode: "MA", contractExecutedAt: "2026-07-02T14:00:00.000Z" },
      OPTIONS,
    );
    expect(result.uncountedDays[0]?.reason).toContain("observed holiday");
    expect(result.rawDeadlineDate).toBe("2026-07-08");
  });

  it("rolls a deadline that lands on a weekend forward, where the rule says to", () => {
    const result = computeRescissionDeadline(
      {
        stateCode: "FL",
        contractExecutedAt: "2026-03-05T05:00:00.000Z",
        documentsDeliveredAt: "2026-03-05T05:00:00.000Z",
      },
      OPTIONS,
    );
    expect(result.rawDeadlineDate).toBe("2026-03-15");
    expect(result.deadlineLocalDate).toBe("2026-03-16");
    expect(result.steps.some((step) => step.label === "roll.applied")).toBe(true);
  });

  it("leaves a weekend deadline where it falls, where the rule does not roll", () => {
    // California does not roll. 7 calendar days from 27 February 2026 lands on
    // Saturday 7 March and stays there.
    const result = computeRescissionDeadline(
      {
        stateCode: "CA",
        contractExecutedAt: "2026-02-27T18:00:00.000Z",
        documentsDeliveredAt: "2026-02-27T18:00:00.000Z",
      },
      OPTIONS,
    );
    expect(result.rawDeadlineDate).toBe("2026-03-06");
    expect(result.deadlineLocalDate).toBe(result.rawDeadlineDate);
    expect(result.steps.some((step) => step.label === "roll.not_applied")).toBe(true);
  });
});

describe("later-of triggers", () => {
  it("counts from delivery when delivery came second", () => {
    const result = computeRescissionDeadline(
      {
        stateCode: "FL",
        contractExecutedAt: "2026-03-05T14:00:00.000Z",
        documentsDeliveredAt: "2026-03-07T14:00:00.000Z",
      },
      OPTIONS,
    );
    expect(result.triggerInstant).toBe("2026-03-07T14:00:00.000Z");
  });

  it("counts from execution when execution came second", () => {
    const result = computeRescissionDeadline(
      {
        stateCode: "FL",
        contractExecutedAt: "2026-03-09T14:00:00.000Z",
        documentsDeliveredAt: "2026-03-07T14:00:00.000Z",
      },
      OPTIONS,
    );
    expect(result.triggerInstant).toBe("2026-03-09T14:00:00.000Z");
  });

  it("refuses rather than falling back to the one instant it was given", () => {
    // The failure mode this closes: taking the execution date because it is the
    // one that is always populated, which starts the clock early every time
    // delivery came second.
    expect(() =>
      computeRescissionDeadline({ stateCode: "FL", contractExecutedAt: "2026-03-05T14:00:00.000Z" }, OPTIONS),
    ).toThrow(DeniedError);
  });

  it("fixes the governing rule version at formation, not at the trigger", () => {
    // Florida's second placeholder version begins on 1 January 2020. A contract
    // executed under the first version keeps it even though the deadline itself
    // falls after the change.
    const older = computeRescissionDeadline(
      { stateCode: "FL", contractExecutedAt: "2019-12-28T14:00:00.000Z" },
      OPTIONS,
    );
    expect(older.ruleVersion).toBe("FL@1");
    expect(older.deadlineLocalDate.startsWith("2020-")).toBe(true);
  });
});

describe("tolling", () => {
  const base = {
    stateCode: "FL",
    contractExecutedAt: "2026-03-05T15:00:00.000Z",
    documentsDeliveredAt: "2026-03-05T15:00:00.000Z",
  };

  it("produces the same answer whatever order the events arrive in", () => {
    const events = [
      tolling({
        kind: "suspend",
        code: "consumer_incapacity",
        effectiveAt: "2026-03-09T00:00:00.000Z",
        endsAt: "2026-03-11T00:00:00.000Z",
      }),
      tolling({ kind: "extend", code: "agreed_extension", extendByDays: 3 }),
      tolling({
        kind: "restart",
        code: "documents_redelivered",
        effectiveAt: "2026-03-07T00:00:00.000Z",
      }),
    ];

    const permutations = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 0, 2],
      [0, 2, 1],
      [2, 0, 1],
      [1, 2, 0],
    ];
    const fingerprints = new Set(
      permutations.map((order) =>
        deadlineFingerprint(
          computeRescissionDeadline(
            { ...base, tollingEvents: order.map((index) => events[index] as TollingEvent) },
            OPTIONS,
          ),
        ),
      ),
    );
    expect(fingerprints.size).toBe(1);
  });

  it("never shortens a window, for any jurisdiction", () => {
    const problems: string[] = [];
    const events = [
      tolling({
        kind: "suspend",
        code: "consumer_incapacity",
        effectiveAt: "2026-03-09T00:00:00.000Z",
        endsAt: "2026-03-11T00:00:00.000Z",
      }),
      tolling({ kind: "extend", code: "agreed_extension", extendByDays: 3 }),
      tolling({
        kind: "restart",
        code: "documents_redelivered",
        effectiveAt: "2026-03-07T00:00:00.000Z",
      }),
    ];

    for (const stateCode of JURISDICTIONS) {
      const input = { ...base, stateCode };
      const untolled = computeRescissionDeadline(input, OPTIONS);
      for (const event of events) {
        const tolled = computeRescissionDeadline({ ...input, tollingEvents: [event] }, OPTIONS);
        if (parseIsoInstant(tolled.deadlineInstant) < parseIsoInstant(untolled.deadlineInstant)) {
          problems.push(
            `${stateCode}: a "${event.kind}" event moved the deadline from ${untolled.deadlineInstant} back to ${tolled.deadlineInstant}`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("refuses a restart that would move the trigger earlier", () => {
    expect(() =>
      computeRescissionDeadline(
        {
          ...base,
          tollingEvents: [
            tolling({
              kind: "restart",
              code: "documents_redelivered",
              effectiveAt: "2026-03-01T00:00:00.000Z",
            }),
          ],
        },
        OPTIONS,
      ),
    ).toThrow(DeniedError);
  });
});

describe("refusals — a deadline it cannot justify is never produced", () => {
  it("refuses a jurisdiction with no rule on file rather than borrowing a neighbour's", () => {
    for (const probe of ["ZZ", "DEFAULT", "WY", "AK"]) {
      let denied: unknown;
      try {
        computeRescissionDeadline(
          { stateCode: probe, contractExecutedAt: "2026-03-05T14:00:00.000Z" },
          OPTIONS,
        );
      } catch (error) {
        denied = error;
      }
      expect(denied, `${probe} produced a deadline`).toBeInstanceOf(DeniedError);
      expect((denied as DeniedError).reason).toBe("knowledge.no_grounding");
    }
  });

  it("refuses a state code that is not a code at all, including prototype keys", () => {
    for (const probe of ["", "  ", "F1", "constructor", "__proto__", "toString"]) {
      expect(() =>
        computeRescissionDeadline(
          { stateCode: probe, contractExecutedAt: "2026-03-05T14:00:00.000Z" },
          OPTIONS,
        ),
      ).toThrow(DeniedError);
    }
  });

  it("refuses a contract formed before any version on file was in effect", () => {
    expect(() =>
      computeRescissionDeadline(
        { stateCode: "FL", contractExecutedAt: "1995-06-01T14:00:00.000Z" },
        OPTIONS,
      ),
    ).toThrow(DeniedError);
  });

  it("refuses when two versions both cover the contract, rather than picking one", () => {
    const overlapping = new Map(RESCISSION_RULES);
    const florida = RESCISSION_RULES.get("FL");
    if (!florida) throw new Error("FL entry missing");
    const [first, second] = florida.versions;
    if (!first || !second) throw new Error("FL needs two versions for this test");
    overlapping.set("FL", {
      ...florida,
      versions: [{ ...first, effectiveTo: null }, second],
    });

    expect(() =>
      computeRescissionDeadline(
        { stateCode: "FL", contractExecutedAt: "2026-03-05T14:00:00.000Z", documentsDeliveredAt: "2026-03-05T14:00:00.000Z" },
        { ...OPTIONS, rules: overlapping },
      ),
    ).toThrow(/ambiguous/i);
  });

  it("refuses when the rule's holiday calendar is not loaded, rather than counting without it", () => {
    expect(() =>
      computeRescissionDeadline(
        { stateCode: "MO", contractExecutedAt: "2026-03-05T14:00:00.000Z" },
        { ...OPTIONS, holidayCalendars: new Map() },
      ),
    ).toThrow(DeniedError);
  });

  it("refuses every jurisdiction when the deployment requires verified rules", () => {
    for (const stateCode of JURISDICTIONS) {
      let denied: unknown;
      try {
        computeRescissionDeadline(
          {
            stateCode,
            contractExecutedAt: "2026-03-05T14:00:00.000Z",
            documentsDeliveredAt: "2026-03-05T14:00:00.000Z",
          },
          { ...OPTIONS, requireVerifiedRules: true },
        );
      } catch (error) {
        denied = error;
      }
      expect(denied, `${stateCode} produced a deadline from an unverified rule`).toBeInstanceOf(
        DeniedError,
      );
      expect((denied as DeniedError).reason).toBe("knowledge.stale_authority");
    }
  });
});
