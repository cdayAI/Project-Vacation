import { describe, expect, it } from "vitest";
import {
  NOT_RECORDED,
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

describe("pluralise", () => {
  it("agrees the noun with the count", () => {
    expect(pluralise(1, "item", "items")).toBe("1 item");
    expect(pluralise(0, "item", "items")).toBe("0 items");
    expect(pluralise(3, "item", "items")).toBe("3 items");
  });
});
