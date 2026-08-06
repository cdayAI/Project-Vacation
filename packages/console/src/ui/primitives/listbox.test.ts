import { describe, expect, it } from "vitest";
import {
  firstEnabledIndex,
  indexOfValue,
  isTypeAheadKey,
  lastEnabledIndex,
  stepIndex,
  typeAheadIndex,
  type ListOption,
} from "./listbox";

const STATUSES: readonly ListOption[] = [
  { value: "open", label: "Open" },
  { value: "parked", label: "Parked" },
  { value: "pending", label: "Pending review" },
  { value: "posted", label: "Posted" },
  { value: "closed", label: "Closed" },
];

const WITH_DISABLED: readonly ListOption[] = [
  { value: "a", label: "Alpha", disabled: true },
  { value: "b", label: "Bravo" },
  { value: "c", label: "Charlie", disabled: true },
  { value: "d", label: "Delta" },
  { value: "e", label: "Echo", disabled: true },
];

describe("stepIndex", () => {
  it("moves one at a time", () => {
    expect(stepIndex(STATUSES, 0, 1, true)).toBe(1);
    expect(stepIndex(STATUSES, 2, -1, true)).toBe(1);
  });

  it("wraps past the end when asked to", () => {
    expect(stepIndex(STATUSES, 4, 1, true)).toBe(0);
    expect(stepIndex(STATUSES, 0, -1, true)).toBe(4);
  });

  it("stops at the end when not", () => {
    expect(stepIndex(STATUSES, 4, 1, false)).toBe(4);
    expect(stepIndex(STATUSES, 0, -1, false)).toBe(0);
  });

  it("opens on the first option when nothing is active yet", () => {
    expect(stepIndex(STATUSES, -1, 1, true)).toBe(0);
    expect(stepIndex(STATUSES, -1, -1, true)).toBe(4);
  });

  it("steps over disabled options rather than landing on one", () => {
    // Landing on a disabled option would let Enter commit something the
    // operator is not allowed to choose.
    expect(stepIndex(WITH_DISABLED, -1, 1, true)).toBe(1);
    expect(stepIndex(WITH_DISABLED, 1, 1, true)).toBe(3);
    expect(stepIndex(WITH_DISABLED, 3, 1, true)).toBe(1);
    expect(stepIndex(WITH_DISABLED, 1, -1, true)).toBe(3);
  });

  it("returns nowhere when every option is disabled", () => {
    const allDisabled = STATUSES.map((option) => ({ ...option, disabled: true }));
    expect(stepIndex(allDisabled, -1, 1, true)).toBe(-1);
    expect(firstEnabledIndex(allDisabled)).toBe(-1);
    expect(lastEnabledIndex(allDisabled)).toBe(-1);
  });

  it("has nowhere to go in an empty list", () => {
    expect(stepIndex([], -1, 1, true)).toBe(-1);
    expect(firstEnabledIndex([])).toBe(-1);
  });
});

describe("first and last", () => {
  it("skips a disabled option at either end", () => {
    expect(firstEnabledIndex(WITH_DISABLED)).toBe(1);
    expect(lastEnabledIndex(WITH_DISABLED)).toBe(3);
  });
});

describe("typeAheadIndex", () => {
  it("jumps to the first option starting with the character", () => {
    expect(typeAheadIndex(STATUSES, "c", -1)).toBe(4);
    expect(typeAheadIndex(STATUSES, "o", -1)).toBe(0);
  });

  it("cycles through the matches when the same character repeats", () => {
    // "p" three times walks Parked → Pending review → Posted.
    expect(typeAheadIndex(STATUSES, "p", -1)).toBe(1);
    expect(typeAheadIndex(STATUSES, "pp", 1)).toBe(2);
    expect(typeAheadIndex(STATUSES, "ppp", 2)).toBe(3);
    expect(typeAheadIndex(STATUSES, "pppp", 3)).toBe(1);
  });

  it("narrows instead of cycling once the characters differ", () => {
    expect(typeAheadIndex(STATUSES, "po", 1)).toBe(3);
    expect(typeAheadIndex(STATUSES, "pen", 1)).toBe(2);
  });

  it("ignores case", () => {
    expect(typeAheadIndex(STATUSES, "PEN", -1)).toBe(2);
  });

  it("never lands on a disabled option", () => {
    expect(typeAheadIndex(WITH_DISABLED, "a", -1)).toBe(-1);
    expect(typeAheadIndex(WITH_DISABLED, "c", -1)).toBe(-1);
    expect(typeAheadIndex(WITH_DISABLED, "d", -1)).toBe(3);
  });

  it("reports no match rather than guessing", () => {
    expect(typeAheadIndex(STATUSES, "z", -1)).toBe(-1);
    expect(typeAheadIndex(STATUSES, "", -1)).toBe(-1);
  });
});

describe("isTypeAheadKey", () => {
  const base = { ctrlKey: false, metaKey: false, altKey: false };

  it("accepts a printable character", () => {
    expect(isTypeAheadKey({ ...base, key: "p" })).toBe(true);
    expect(isTypeAheadKey({ ...base, key: "7" })).toBe(true);
  });

  it("refuses a named key", () => {
    expect(isTypeAheadKey({ ...base, key: "Enter" })).toBe(false);
    expect(isTypeAheadKey({ ...base, key: "ArrowDown" })).toBe(false);
    expect(isTypeAheadKey({ ...base, key: " " })).toBe(false);
  });

  it("refuses a modified keystroke, which belongs to a shortcut", () => {
    expect(isTypeAheadKey({ ...base, key: "a", ctrlKey: true })).toBe(false);
    expect(isTypeAheadKey({ ...base, key: "v", metaKey: true })).toBe(false);
  });
});

describe("indexOfValue", () => {
  it("finds a value and reports −1 for none", () => {
    expect(indexOfValue(STATUSES, "posted")).toBe(3);
    expect(indexOfValue(STATUSES, "missing")).toBe(-1);
    expect(indexOfValue(STATUSES, null)).toBe(-1);
  });
});
