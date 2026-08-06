import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_USE_STORAGE_KEY,
  clearCommandUse,
  familiarity,
  pruneCommandUse,
  readCommandUse,
  recordCommandUse,
  writeCommandUse,
} from "./frequency";

afterEach(() => {
  window.localStorage.clear();
});

const DAY = 24 * 60 * 60 * 1000;

describe("remembering what an operator uses", () => {
  it("starts empty", () => {
    expect(readCommandUse()).toEqual({});
  });

  it("counts a run and remembers when it happened", () => {
    const now = Date.UTC(2026, 7, 6, 9, 0, 0);
    recordCommandUse("approve", { now });
    recordCommandUse("approve", { now: now + 1000 });

    expect(readCommandUse()["approve"]).toEqual({ count: 2, at: now + 1000 });
  });

  it("survives a round trip through storage", () => {
    writeCommandUse({ approve: { count: 3, at: 1 } });
    expect(readCommandUse()["approve"]?.count).toBe(3);
  });

  it("clears on request", () => {
    recordCommandUse("approve");
    clearCommandUse();
    expect(readCommandUse()).toEqual({});
  });

  it("reads unparseable storage as no history rather than throwing", () => {
    // Written by an older build, or edited by hand. An unreadable history must
    // never be the reason the palette fails to open.
    window.localStorage.setItem(COMMAND_USE_STORAGE_KEY, "{not json");
    expect(readCommandUse()).toEqual({});
  });

  it("discards entries that are the wrong shape", () => {
    window.localStorage.setItem(
      COMMAND_USE_STORAGE_KEY,
      JSON.stringify({ good: { count: 2, at: 5 }, bad: { count: "many" }, worse: null }),
    );
    expect(readCommandUse()).toEqual({ good: { count: 2, at: 5 } });
  });

  it("does not throw when storage refuses to be written", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => recordCommandUse("approve")).not.toThrow();
    setItem.mockRestore();
  });

  it("keeps the most recent entries when it is over the limit", () => {
    const uses = {
      old: { count: 40, at: 1 },
      middle: { count: 1, at: 2 },
      recent: { count: 1, at: 3 },
    };
    expect(Object.keys(pruneCommandUse(uses, 2)).sort()).toEqual(["middle", "recent"]);
  });

  it("leaves a map that is inside the limit alone", () => {
    const uses = { a: { count: 1, at: 1 } };
    expect(pruneCommandUse(uses, 10)).toBe(uses);
  });
});

describe("familiarity", () => {
  const now = Date.UTC(2026, 7, 6, 9, 0, 0);

  it("is nothing for a command that has never been run", () => {
    expect(familiarity(undefined, now)).toBe(0);
  });

  it("rises with repetition", () => {
    const once = familiarity({ count: 1, at: now }, now);
    const often = familiarity({ count: 10, at: now }, now);
    expect(often).toBeGreaterThan(once);
  });

  it("stops rising past the ceiling, so habit cannot outrank a search", () => {
    const many = familiarity({ count: 12, at: now }, now);
    const absurd = familiarity({ count: 5000, at: now }, now);
    expect(absurd).toBe(many);
  });

  it("fades as a run recedes, but never below what repetition earned", () => {
    const today = familiarity({ count: 6, at: now }, now);
    const lastWeek = familiarity({ count: 6, at: now - 8 * DAY }, now);
    expect(lastWeek).toBeLessThan(today);
    expect(lastWeek).toBeGreaterThan(0);
  });

  it("never exceeds a hundred, which is what keeps it below match quality", () => {
    expect(familiarity({ count: 9999, at: now }, now)).toBeLessThanOrEqual(100);
  });
});
