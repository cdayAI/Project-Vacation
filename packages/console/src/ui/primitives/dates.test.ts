import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  compareIso,
  daysInMonth,
  describeParseFailure,
  formatDate,
  formatDateSpoken,
  fromIso,
  isWithin,
  monthGrid,
  parseDate,
  toIso,
  todayIso,
} from "./dates";

describe("parseDate", () => {
  const referenceYear = 2026;

  it.each([
    ["2026-06-12", "2026-06-12"],
    ["12 Jun 2026", "2026-06-12"],
    ["12 June 2026", "2026-06-12"],
    ["12 jun 2026", "2026-06-12"],
    ["Jun 12 2026", "2026-06-12"],
    ["June 12, 2026", "2026-06-12"],
    ["12-Jun-2026", "2026-06-12"],
    ["  12   Jun   2026 ", "2026-06-12"],
    ["1 Jan 2026", "2026-01-01"],
    ["31 Dec 2026", "2026-12-31"],
    ["29 Feb 2024", "2024-02-29"],
  ])("reads %s as %s", (input, expected) => {
    const result = parseDate(input, referenceYear);
    expect(result).toEqual({ ok: true, value: expected });
  });

  it("resolves a date with no year against the reference year, not against now", () => {
    // Editing a 2024 record and typing "3 Mar" must not move it to this year.
    expect(parseDate("3 Mar", 2024)).toEqual({ ok: true, value: "2024-03-03" });
    expect(parseDate("Mar 3", 2031)).toEqual({ ok: true, value: "2031-03-03" });
  });

  it("refuses a slashed date rather than guessing which end is the month", () => {
    for (const input of ["12/06/2026", "06/12/2026", "12/6", "2026/06/12", "12.06.2026"]) {
      expect(parseDate(input, referenceYear)).toEqual({ ok: false, reason: "ambiguous" });
    }
  });

  it("names both accepted formats when it refuses", () => {
    const message = describeParseFailure("ambiguous");
    expect(message).toContain("12 Jun 2026");
    expect(message).toContain("2026-06-12");
    // §6: never blame the operator, never say "invalid".
    expect(message.toLowerCase()).not.toContain("invalid");
  });

  it("rejects a day that does not exist in that month", () => {
    expect(parseDate("31 Feb 2026", referenceYear)).toEqual({ ok: false, reason: "impossible" });
    expect(parseDate("29 Feb 2026", referenceYear)).toEqual({ ok: false, reason: "impossible" });
    expect(parseDate("2026-13-01", referenceYear)).toEqual({ ok: false, reason: "impossible" });
  });

  it("rejects an unreadable month name", () => {
    expect(parseDate("12 Jum 2026", referenceYear)).toEqual({
      ok: false,
      reason: "unrecognised",
    });
  });

  it("reports an empty field as empty rather than as a failure to read", () => {
    expect(parseDate("   ", referenceYear)).toEqual({ ok: false, reason: "empty" });
  });

  it("has a sentence for every failure, and none of them says 'invalid input'", () => {
    for (const reason of ["empty", "ambiguous", "unrecognised", "impossible"] as const) {
      const message = describeParseFailure(reason);
      expect(message.length).toBeGreaterThan(20);
      expect(message.toLowerCase()).not.toContain("invalid input");
    }
  });
});

describe("calendar arithmetic", () => {
  it("knows the length of every month, including a leap February", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it("clamps a month step to the end of the target month", () => {
    // The platform's own arithmetic overflows 31 January into 3 March, which in
    // a picker means Page Down skips February.
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("steps across a year boundary in both directions", () => {
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("orders dates as strings, which is the point of the ISO shape", () => {
    expect(compareIso("2026-06-12", "2026-06-13")).toBe(-1);
    expect(compareIso("2026-06-12", "2026-06-12")).toBe(0);
    expect(compareIso("2027-01-01", "2026-12-31")).toBe(1);
  });

  it("bounds a date between two ends, inclusive", () => {
    expect(isWithin("2026-06-12", "2026-06-01", "2026-06-30")).toBe(true);
    expect(isWithin("2026-06-01", "2026-06-01", "2026-06-30")).toBe(true);
    expect(isWithin("2026-05-31", "2026-06-01", undefined)).toBe(false);
    expect(isWithin("2026-07-01", undefined, "2026-06-30")).toBe(false);
  });

  it("draws six rows for every month, so the popup never changes height", () => {
    for (const [year, month] of [
      [2026, 2],
      [2026, 6],
      [2027, 5],
      [2024, 2],
    ] as const) {
      expect(monthGrid(year, month)).toHaveLength(42);
    }
  });

  it("starts the grid on the Sunday of the week the first falls in", () => {
    // 1 June 2026 is a Monday, so the grid opens on Sunday 31 May.
    const grid = monthGrid(2026, 6);
    expect(grid[0]).toBe("2026-05-31");
    expect(grid[1]).toBe("2026-06-01");
    expect(grid[41]).toBe("2026-07-11");
  });
});

describe("formatting", () => {
  it("writes one shape and only one", () => {
    expect(formatDate("2026-06-12")).toBe("12 Jun 2026");
    expect(formatDate("2026-01-01")).toBe("1 Jan 2026");
  });

  it("spells the month out for anything that will be read aloud", () => {
    expect(formatDateSpoken("2026-06-12")).toBe("12 June 2026");
  });

  it("round-trips through the ISO shape", () => {
    const parts = fromIso("2026-06-12");
    expect(parts).toEqual({ year: 2026, month: 6, day: 12 });
    expect(parts === null ? "" : toIso(parts)).toBe("2026-06-12");
  });

  it("refuses to read a malformed or impossible ISO string", () => {
    expect(fromIso("2026-6-1")).toBeNull();
    expect(fromIso("2026-02-30")).toBeNull();
    expect(fromIso("not a date")).toBeNull();
  });

  it("reads today from the local calendar, not from UTC", () => {
    // A record dated 12 June is dated 12 June wherever the browser is: taking
    // the date from an instant is how the same row shows two different days.
    const now = new Date(2026, 5, 12, 23, 30);
    expect(todayIso(now)).toBe("2026-06-12");
  });
});
