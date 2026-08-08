import { describe, it, expect } from "vitest";
import { InvalidInputError } from "../kernel/errors.js";
import {
  BASE_HOLIDAYS,
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
import type { CivilDate, Holiday, HolidayCalendar, Weekday } from "./types.js";

const WEEKEND: readonly Weekday[] = [0, 6];
const FL_CALENDAR = jurisdictionCalendar("FL");

function date(year: number, month: number, day: number): CivilDate {
  return { year, month, day };
}

describe("civil date arithmetic", () => {
  it("round-trips every day across a decade including leap years", () => {
    const start = daysFromCivil(date(2020, 1, 1));
    const end = daysFromCivil(date(2030, 1, 1));
    for (let day = start; day <= end; day += 1) {
      expect(daysFromCivil(civilFromDays(day))).toBe(day);
    }
  });

  it("agrees with known epoch anchors", () => {
    expect(daysFromCivil(date(1970, 1, 1))).toBe(0);
    expect(daysFromCivil(date(1969, 12, 31))).toBe(-1);
    expect(formatCivilDate(civilFromDays(0))).toBe("1970-01-01");
  });

  it("gets the day of week right, including the 1970 anchor", () => {
    expect(dayOfWeek(date(1970, 1, 1))).toBe(4); // Thursday
    expect(dayOfWeek(date(2026, 8, 6))).toBe(4);
    expect(dayOfWeek(date(2026, 3, 15))).toBe(0); // Sunday
    expect(dayOfWeek(date(2026, 7, 4))).toBe(6); // Saturday
  });

  it("crosses month, year, and leap-day boundaries", () => {
    expect(formatCivilDate(addDays(date(2026, 1, 31), 1))).toBe("2026-02-01");
    expect(formatCivilDate(addDays(date(2026, 12, 28), 10))).toBe("2027-01-07");
    expect(formatCivilDate(addDays(date(2028, 2, 28), 1))).toBe("2028-02-29");
    expect(formatCivilDate(addDays(date(2026, 2, 28), 1))).toBe("2026-03-01");
    expect(formatCivilDate(addDays(date(2000, 2, 28), 1))).toBe("2000-02-29"); // 2000 is a leap year
    expect(formatCivilDate(addDays(date(1900, 2, 28), 1))).toBe("1900-03-01"); // 1900 is not
  });

  it("subtracts as well as it adds", () => {
    expect(formatCivilDate(addDays(date(2027, 1, 7), -10))).toBe("2026-12-28");
  });

  it("refuses fractional day counts rather than truncating them", () => {
    expect(() => addDays(date(2026, 1, 1), 1.5)).toThrow(InvalidInputError);
  });

  it("orders dates", () => {
    expect(compareCivilDates(date(2026, 1, 1), date(2026, 1, 2))).toBeLessThan(0);
    expect(compareCivilDates(date(2026, 1, 2), date(2026, 1, 1))).toBeGreaterThan(0);
    expect(compareCivilDates(date(2026, 1, 1), date(2026, 1, 1))).toBe(0);
  });
});

describe("parsing", () => {
  it("accepts a well-formed civil date", () => {
    expect(parseIsoDate("2026-08-06")).toEqual({ year: 2026, month: 8, day: 6 });
  });

  it("rejects a date that does not exist rather than rolling it over", () => {
    // Permissive parsing turns this into 2026-03-02, which would silently move
    // an effective date by two days.
    expect(() => parseIsoDate("2026-02-30")).toThrow(InvalidInputError);
    expect(() => parseIsoDate("2026-13-01")).toThrow(InvalidInputError);
    expect(() => parseIsoDate("2026-00-10")).toThrow(InvalidInputError);
  });

  it("rejects loose formatting", () => {
    expect(() => parseIsoDate("2026-8-6")).toThrow(InvalidInputError);
    expect(() => parseIsoDate("06/08/2026")).toThrow(InvalidInputError);
    expect(() => parseIsoDate("")).toThrow(InvalidInputError);
  });

  it("accepts an instant with a UTC designator or an explicit offset", () => {
    expect(parseIsoInstant("2026-08-06T12:00:00.000Z")).toBe(Date.parse("2026-08-06T12:00:00Z"));
    expect(parseIsoInstant("2026-08-06T08:00:00-04:00")).toBe(Date.parse("2026-08-06T12:00:00Z"));
  });

  it("refuses a timestamp with no zone at all", () => {
    // Interpreting this would mean guessing a timezone, which is precisely the
    // failure this module exists to prevent.
    expect(() => parseIsoInstant("2026-08-06T12:00:00")).toThrow(InvalidInputError);
    expect(() => parseIsoInstant("2026-08-06")).toThrow(InvalidInputError);
    expect(() => parseIsoInstant("yesterday")).toThrow(InvalidInputError);
  });

  it("formats an instant back to UTC", () => {
    expect(formatInstant(Date.parse("2026-08-06T12:00:00Z"))).toBe("2026-08-06T12:00:00.000Z");
  });
});

describe("timezone handling", () => {
  it("recognises IANA zones and rejects fixed offsets dressed up as zones", () => {
    expect(isKnownTimeZone("America/New_York")).toBe(true);
    expect(isKnownTimeZone("Pacific/Honolulu")).toBe(true);
    expect(isKnownTimeZone("Not/AZone")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
  });

  it("rejects the tz database's fixed-offset aliases, which freeze the offset", () => {
    // L18. `Intl` resolves the legacy abbreviation aliases `EST`, `MST`, `HST`
    // and `GMT`, and the whole `Etc/GMT±N` family, and every one of them is a
    // fixed offset with no daylight-saving rule — the same fault as a bare
    // `-05:00`, in an IANA-shaped disguise. `EST` reads 11:00 when New York is
    // at 12:00, which for quiet hours is the difference between a lawful call
    // and an unlawful one, and it fails in the permissive direction.
    for (const alias of ["EST", "MST", "HST", "GMT", "Etc/GMT+5", "Etc/GMT-8", "Etc/UTC", "est"]) {
      expect(isKnownTimeZone(alias), alias).toBe(false);
    }

    // A curated deny-list of the offset aliases, not a ban on single-part names.
    // A genuine place that happens not to observe daylight saving still resolves,
    // as does the honest UTC identifier, which is never wrong by an hour.
    for (const zone of ["Singapore", "Japan", "Iceland", "UTC", "America/Phoenix"]) {
      expect(isKnownTimeZone(zone), zone).toBe(true);
    }
  });

  it("tracks daylight saving rather than assuming a constant offset", () => {
    const before = offsetMsAt(Date.parse("2026-03-07T12:00:00Z"), "America/New_York");
    const after = offsetMsAt(Date.parse("2026-03-09T12:00:00Z"), "America/New_York");
    expect(formatOffset(before)).toBe("-05:00");
    expect(formatOffset(after)).toBe("-04:00");

    const autumnBefore = offsetMsAt(Date.parse("2026-10-31T12:00:00Z"), "America/New_York");
    const autumnAfter = offsetMsAt(Date.parse("2026-11-02T12:00:00Z"), "America/New_York");
    expect(formatOffset(autumnBefore)).toBe("-04:00");
    expect(formatOffset(autumnAfter)).toBe("-05:00");
  });

  it("holds the offset steady in zones that do not observe daylight saving", () => {
    for (const instant of ["2026-01-15T12:00:00Z", "2026-07-15T12:00:00Z"]) {
      expect(formatOffset(offsetMsAt(Date.parse(instant), "Pacific/Honolulu"))).toBe("-10:00");
      expect(formatOffset(offsetMsAt(Date.parse(instant), "America/Phoenix"))).toBe("-07:00");
    }
  });

  it("reads local wall-clock fields in the named zone", () => {
    const fields = zonedFieldsAt(Date.parse("2026-08-06T03:15:30.250Z"), "America/New_York");
    expect(fields).toEqual({
      year: 2026,
      month: 8,
      day: 5,
      hour: 23,
      minute: 15,
      second: 30,
      millisecond: 250,
    });
  });

  it("puts an instant on the correct local date across the date line of a day", () => {
    // 03:15 UTC is still the previous day in New York.
    expect(formatCivilDate(localDateAt(Date.parse("2026-08-06T03:15:00Z"), "America/New_York"))).toBe(
      "2026-08-05",
    );
    expect(formatCivilDate(localDateAt(Date.parse("2026-08-06T03:15:00Z"), "UTC"))).toBe("2026-08-06");
  });

  it("maps an unambiguous local time to exactly one instant", () => {
    const resolved = instantFromZoned(
      { year: 2026, month: 8, day: 6, hour: 23, minute: 59, second: 59, millisecond: 999 },
      "America/New_York",
    );
    expect(resolved.resolution).toBe("unique");
    expect(formatInstant(resolved.instant)).toBe("2026-08-07T03:59:59.999Z");
  });

  it("resolves an ambiguous local time — the hour that happens twice — to the later occurrence", () => {
    // Clocks go back at 02:00 local on 2026-11-01 in New York, so 01:30 happens
    // at both 05:30Z (EDT) and 06:30Z (EST). The later reading gives the
    // consumer the longer window.
    const resolved = instantFromZoned(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0, millisecond: 0 },
      "America/New_York",
    );
    expect(resolved.resolution).toBe("ambiguous_later");
    expect(formatInstant(resolved.instant)).toBe("2026-11-01T06:30:00.000Z");
  });

  it("resolves a local time that never happens to the first instant after the gap", () => {
    // Clocks jump 02:00 -> 03:00 local on 2026-03-08 in New York, so 02:30
    // does not exist that day.
    const resolved = instantFromZoned(
      { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0, millisecond: 0 },
      "America/New_York",
    );
    expect(resolved.resolution).toBe("nonexistent_shifted");
    expect(formatInstant(resolved.instant)).toBe("2026-03-08T07:30:00.000Z");
    expect(formatCivilDate(localDateAt(resolved.instant, "America/New_York"))).toBe("2026-03-08");
  });

  it("round-trips local noon back to the same local date every day across both transitions", () => {
    let cursor = date(2026, 2, 20);
    for (let i = 0; i < 300; i += 1) {
      const resolved = instantFromZoned(
        { ...cursor, hour: 12, minute: 0, second: 0, millisecond: 0 },
        "America/New_York",
      );
      expect(formatCivilDate(localDateAt(resolved.instant, "America/New_York"))).toBe(
        formatCivilDate(cursor),
      );
      cursor = addDays(cursor, 1);
    }
  });

  it("starts a local day at local midnight, not at UTC midnight", () => {
    const winter = startOfLocalDay(date(2026, 1, 15), "America/New_York");
    expect(formatInstant(winter.instant)).toBe("2026-01-15T05:00:00.000Z");
    const summer = startOfLocalDay(date(2026, 7, 15), "America/New_York");
    expect(formatInstant(summer.instant)).toBe("2026-07-15T04:00:00.000Z");
  });

  it("refuses an unknown zone rather than falling back to UTC", () => {
    expect(() => offsetMsAt(0, "Atlantis/Capital")).toThrow(InvalidInputError);
  });

  it("formats offsets on both sides of UTC", () => {
    expect(formatOffset(0)).toBe("+00:00");
    expect(formatOffset(-5 * 3_600_000)).toBe("-05:00");
    expect(formatOffset(5.5 * 3_600_000)).toBe("+05:30");
  });
});

describe("holidays", () => {
  it("places nth-weekday holidays correctly", () => {
    const observed = holidaysInYear(FL_CALENDAR, 2026);
    expect(observed.get("2026-01-19")).toBe("Third Monday in January");
    expect(observed.get("2026-05-25")).toBe("Last Monday in May");
    expect(observed.get("2026-11-26")).toBe("Fourth Thursday in November");
  });

  it("shifts a fixed-date holiday off a weekend", () => {
    // 2026-07-04 is a Saturday, so it is observed on the Friday.
    expect(dayOfWeek(date(2026, 7, 4))).toBe(6);
    expect(holidaysInYear(FL_CALENDAR, 2026).get("2026-07-03")).toBe("July 4");
    expect(holidaysInYear(FL_CALENDAR, 2026).has("2026-07-04")).toBe(false);
  });

  it("carries an observance shift across a year boundary", () => {
    // 2028-01-01 is a Saturday, so it is observed on 2027-12-31. A generator
    // that only looked at its own year would lose this day entirely.
    expect(holidaysInYear(FL_CALENDAR, 2027).get("2027-12-31")).toBe("New Year's Day");
  });

  it("returns the same index on a second call", () => {
    const first = holidaysInYear(FL_CALENDAR, 2026);
    const second = holidaysInYear(FL_CALENDAR, 2026);
    expect([...second.keys()]).toEqual([...first.keys()]);
  });

  it("supports explicit one-off dates for holidays with no closed form", () => {
    const oneOff: Holiday = {
      id: "test.proclaimed",
      name: "Proclaimed day of observance",
      definition: { kind: "explicit_dates", dates: ["2026-04-03", "2027-03-26"] },
      verified: false,
    };
    const calendar = jurisdictionCalendar("ZZ", [oneOff]);
    expect(holidayOn(date(2026, 4, 3), calendar)).toBe("Proclaimed day of observance");
    expect(holidayOn(date(2027, 4, 3), calendar)).toBeNull();
  });

  it("ships every holiday marked unverified", () => {
    for (const holiday of BASE_HOLIDAYS) {
      expect(holiday.verified).toBe(false);
    }
    expect(FL_CALENDAR.verified).toBe(false);
    expect(FL_CALENDAR.reviewRequired).toContain("PLACEHOLDER");
  });
});

describe("business days", () => {
  it("treats weekends and observed holidays as non-business days", () => {
    expect(isWeekend(date(2026, 3, 14), WEEKEND)).toBe(true); // Saturday
    expect(isWeekend(date(2026, 3, 16), WEEKEND)).toBe(false); // Monday
    expect(isBusinessDay(date(2026, 11, 26), FL_CALENDAR, WEEKEND)).toBe(false); // holiday
    expect(isBusinessDay(date(2026, 11, 27), FL_CALENDAR, WEEKEND)).toBe(true);
  });

  it("explains why a day did not count, for the derivation record", () => {
    expect(describeNonBusinessDay(date(2026, 3, 15), FL_CALENDAR)).toBe("Sunday (weekend)");
    expect(describeNonBusinessDay(date(2026, 11, 26), FL_CALENDAR)).toBe(
      "Fourth Thursday in November (observed holiday)",
    );
  });

  it("rolls a weekend deadline to the following Monday", () => {
    const rolled = rollToBusinessDay(date(2026, 3, 14), FL_CALENDAR, WEEKEND);
    expect(formatCivilDate(rolled.date)).toBe("2026-03-16");
    expect(rolled.skipped.map((entry) => entry.date)).toEqual(["2026-03-14", "2026-03-15"]);
  });

  it("rolls over a holiday that abuts a weekend", () => {
    // 2026-12-25 is a Friday; the roll from Christmas has to clear the weekend too.
    const rolled = rollToBusinessDay(date(2026, 12, 25), FL_CALENDAR, WEEKEND);
    expect(formatCivilDate(rolled.date)).toBe("2026-12-28");
    expect(rolled.skipped).toHaveLength(3);
  });

  it("leaves a business day where it is", () => {
    const rolled = rollToBusinessDay(date(2026, 3, 16), FL_CALENDAR, WEEKEND);
    expect(formatCivilDate(rolled.date)).toBe("2026-03-16");
    expect(rolled.skipped).toEqual([]);
  });

  it("refuses to spin forever on a calendar with no business days in it", () => {
    // A malformed calendar must fail fast inside a request rather than hang it.
    const everyDay: HolidayCalendar = {
      id: "TEST-EVERY-DAY",
      label: "Every day is a holiday",
      verified: false,
      reviewRequired: "test fixture",
      holidays: Array.from({ length: 366 }, (_, offset) => {
        const day = addDays(date(2026, 1, 1), offset);
        return {
          id: `test.day_${offset}`,
          name: "Closed",
          definition: { kind: "explicit_dates" as const, dates: [formatCivilDate(day)] },
          verified: false,
        };
      }),
    };
    expect(() => rollToBusinessDay(date(2026, 6, 1), everyDay, WEEKEND)).toThrow(InvalidInputError);
  });
});
