import { describe, expect, it } from "vitest";
import {
  NOT_RECORDED,
  formatAge,
  formatCountdown,
  formatDurationMs,
  formatUsd,
  pluralise,
} from "./format";

describe("formatUsd", () => {
  it("keeps four places below a dollar, so sub-cent spend is not rounded to nothing", () => {
    expect(formatUsd(0.0037)).toBe("$0.0037");
    expect(formatUsd(0.0184)).toBe("$0.0184");
    expect(formatUsd(0.4821)).toBe("$0.4821");
  });

  it("reads as money above a dollar", () => {
    expect(formatUsd(2.1408)).toBe("$2.14");
    expect(formatUsd(1284)).toBe("$1,284.00");
  });

  it("shows a genuine zero as a zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("refuses to render a non-number as money", () => {
    expect(formatUsd(Number.NaN)).toBe(NOT_RECORDED);
  });
});

describe("formatDurationMs", () => {
  it("uses the unit that keeps the number readable", () => {
    expect(formatDurationMs(180)).toBe("180 ms");
    expect(formatDurationMs(2400)).toBe("2.4 s");
    expect(formatDurationMs(125_000)).toBe("2 min 05 s");
  });

  it("says so when a duration was never recorded", () => {
    expect(formatDurationMs(undefined)).toBe(NOT_RECORDED);
  });
});

describe("formatCountdown", () => {
  const now = new Date("2026-08-06T10:00:00.000Z");

  it("spells the remaining time out in words", () => {
    expect(formatCountdown("2026-08-06T11:30:00.000Z", now)).toEqual({
      expired: false,
      text: "1 hour 30 minutes remaining",
      totalMs: 90 * 60 * 1000,
    });
  });

  it("includes seconds only when the deadline is inside the hour", () => {
    expect(formatCountdown("2026-08-06T10:02:05.000Z", now).text).toBe(
      "2 minutes 5 seconds remaining",
    );
  });

  it("reports an elapsed deadline as expired rather than as a negative number", () => {
    const countdown = formatCountdown("2026-08-06T09:59:59.000Z", now);
    expect(countdown.expired).toBe(true);
    expect(countdown.text).toBe("Expired");
  });
});

describe("formatAge", () => {
  const now = new Date("2026-08-06T10:00:00.000Z");

  it("stops at two units, so the column does not jitter every minute", () => {
    expect(formatAge("2026-08-04T05:43:00.000Z", now)).toBe("2d 4h");
    expect(formatAge("2026-08-06T05:43:00.000Z", now)).toBe("4h 17m");
  });

  it("drops the second unit when it is zero rather than writing 2d 0h", () => {
    expect(formatAge("2026-08-04T10:00:00.000Z", now)).toBe("2d");
    expect(formatAge("2026-08-06T06:00:00.000Z", now)).toBe("4h");
  });

  it("uses minutes under the hour, and words under the minute", () => {
    expect(formatAge("2026-08-06T09:43:00.000Z", now)).toBe("17m");
    expect(formatAge("2026-08-06T09:59:30.000Z", now)).toBe("just now");
  });

  it("reads a future instant as 'not yet' rather than as a negative age", () => {
    // Browser and platform clocks disagree by small amounts all the time.
    // "-3s" in an age column reads as a defect in the queue.
    expect(formatAge("2026-08-06T10:00:03.000Z", now)).toBe("not yet");
  });

  it("says so when the instant cannot be read", () => {
    expect(formatAge("not a date", now)).toBe(NOT_RECORDED);
  });
});

describe("pluralise", () => {
  it("agrees the noun with the count", () => {
    expect(pluralise(1, "item", "items")).toBe("1 item");
    expect(pluralise(0, "item", "items")).toBe("0 items");
    expect(pluralise(3, "item", "items")).toBe("3 items");
  });
});
