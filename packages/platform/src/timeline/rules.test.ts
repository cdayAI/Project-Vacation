import { describe, it, expect } from "vitest";
import { HOLIDAY_CALENDARS } from "./calendar.js";
import { PLACEHOLDER_MARKER, RESCISSION_RULES, validateRuleTable } from "./rules.js";
import type { JurisdictionTable, RescissionRule } from "./types.js";

/**
 * The honesty tests.
 *
 * The rule table is placeholder data and must never stop looking like it. These
 * tests are the mechanism that keeps that true across future edits: a rule that
 * gains `verified: true` without a citation and a source URL fails the build,
 * and so does a rule whose citation quietly stops carrying the placeholder
 * marker while remaining unverified.
 */

const STATES_IN_SCOPE = [
  "FL",
  "SC",
  "NV",
  "CA",
  "HI",
  "AZ",
  "CO",
  "TX",
  "VA",
  "MO",
  "TN",
  "NY",
  "NJ",
  "MA",
  "UT",
  "NC",
  "GA",
  "MI",
  "WI",
  "IL",
];

function fixtureRule(overrides: Partial<RescissionRule> = {}): RescissionRule {
  return {
    jurisdiction: "ZZ",
    version: "ZZ@1",
    windowLength: 5,
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

function tableOf(...rules: readonly RescissionRule[]): JurisdictionTable {
  return new Map([["ZZ", { jurisdiction: "ZZ", label: "Test jurisdiction", versions: rules }]]);
}

describe("the shipped rule table", () => {
  it("passes every structural and provenance check", () => {
    expect(validateRuleTable(RESCISSION_RULES)).toEqual([]);
  });

  it("declares every rule unverified, with no citation and no source URL", () => {
    for (const entry of RESCISSION_RULES.values()) {
      for (const rule of entry.versions) {
        expect(rule.verified).toBe(false);
        expect(rule.citation.startsWith(PLACEHOLDER_MARKER)).toBe(true);
        expect(rule.sourceUrl).toBe("");
        expect(rule.reviewRequired.length).toBeGreaterThan(0);
      }
    }
  });

  it("covers the states in scope and carries a refusing DEFAULT", () => {
    for (const state of STATES_IN_SCOPE) {
      const entry = RESCISSION_RULES.get(state);
      expect(entry, `missing rule entry for ${state}`).toBeDefined();
      expect(entry?.versions.length ?? 0).toBeGreaterThan(0);
    }
    // The fallback is data with no rule in it, so refusal travels the ordinary
    // "no version covers this contract" path.
    expect(RESCISSION_RULES.get("DEFAULT")?.versions).toEqual([]);
  });

  it("references only holiday calendars that are actually loaded", () => {
    for (const entry of RESCISSION_RULES.values()) {
      for (const rule of entry.versions) {
        expect(
          HOLIDAY_CALENDARS.has(rule.holidayCalendarId),
          `${rule.version} references missing calendar ${rule.holidayCalendarId}`,
        ).toBe(true);
      }
    }
  });

  it("exercises every counting basis and trigger event, so no shape is untested", () => {
    const bases = new Set<string>();
    const triggers = new Set<string>();
    const rolls = new Set<string>();
    for (const entry of RESCISSION_RULES.values()) {
      for (const rule of entry.versions) {
        bases.add(rule.basis);
        triggers.add(rule.trigger);
        rolls.add(rule.roll);
      }
    }
    expect(bases).toEqual(new Set(["calendar_days", "business_days"]));
    expect(triggers).toEqual(
      new Set(["contract_execution", "document_delivery", "later_of_execution_or_delivery"]),
    );
    expect(rolls).toEqual(new Set(["none", "next_business_day"]));
  });
});

describe("validateRuleTable", () => {
  it("fails a rule claiming verification without a citation", () => {
    const problems = validateRuleTable(tableOf(fixtureRule({ verified: true, citation: "  ", sourceUrl: "https://example.gov/x" })));
    expect(problems.map((p) => p.problem)).toContain("Rule is marked verified but carries no citation.");
  });

  it("fails a rule claiming verification without a source URL", () => {
    const problems = validateRuleTable(
      tableOf(fixtureRule({ verified: true, citation: "Test Code s 1", sourceUrl: "" })),
    );
    expect(problems.map((p) => p.problem)).toContain("Rule is marked verified but carries no source URL.");
  });

  it("fails a rule claiming verification while still carrying the placeholder marker", () => {
    // The dangerous edit: flipping the flag without touching the citation.
    const problems = validateRuleTable(
      tableOf(fixtureRule({ verified: true, sourceUrl: "https://example.gov/x" })),
    );
    expect(problems.map((p) => p.problem)).toContain(
      "Rule is marked verified but its citation is still a placeholder.",
    );
  });

  it("accepts a rule that is genuinely verified", () => {
    const problems = validateRuleTable(
      tableOf(
        fixtureRule({
          verified: true,
          citation: "Test Jurisdiction Code, chapter 1, section 2 (synthetic fixture)",
          sourceUrl: "https://example.test/statute",
        }),
      ),
    );
    expect(problems).toEqual([]);
  });

  it("fails an unverified rule whose citation reads like a real one", () => {
    // An unverified rule dressed as authority is worse than one with no
    // citation at all, because a plausible citation gets quoted.
    const problems = validateRuleTable(tableOf(fixtureRule({ citation: "Some Code s 721.10" })));
    expect(problems.map((p) => p.problem)).toContain(
      `Unverified rule's citation must begin with "${PLACEHOLDER_MARKER}".`,
    );
  });

  it("fails overlapping effective periods", () => {
    const problems = validateRuleTable(
      tableOf(
        fixtureRule({ version: "ZZ@1", effectiveFrom: "2000-01-01", effectiveTo: "2020-12-31" }),
        fixtureRule({ version: "ZZ@2", effectiveFrom: "2020-01-01", effectiveTo: null }),
      ),
    );
    expect(problems.map((p) => p.problem)).toContain(
      "Effective periods of ZZ@1 and ZZ@2 overlap.",
    );
  });

  it("accepts abutting effective periods", () => {
    const problems = validateRuleTable(
      tableOf(
        fixtureRule({ version: "ZZ@1", effectiveFrom: "2000-01-01", effectiveTo: "2019-12-31" }),
        fixtureRule({ version: "ZZ@2", effectiveFrom: "2020-01-01", effectiveTo: null }),
      ),
    );
    expect(problems).toEqual([]);
  });

  it("fails a duplicate version identifier", () => {
    const problems = validateRuleTable(
      tableOf(
        fixtureRule({ version: "ZZ@1", effectiveFrom: "2000-01-01", effectiveTo: "2019-12-31" }),
        fixtureRule({ version: "ZZ@1", effectiveFrom: "2020-01-01", effectiveTo: null }),
      ),
    );
    expect(problems.map((p) => p.problem)).toContain("Duplicate version identifier within a jurisdiction.");
  });

  it("fails an unknown timezone", () => {
    const problems = validateRuleTable(tableOf(fixtureRule({ timeZone: "US/Eastern-ish" })));
    expect(problems.map((p) => p.problem)).toContain(
      '"US/Eastern-ish" is not an IANA timezone this runtime recognises.',
    );
  });

  it("fails a window that is not a positive whole number of days", () => {
    expect(validateRuleTable(tableOf(fixtureRule({ windowLength: 0 })))).not.toEqual([]);
    expect(validateRuleTable(tableOf(fixtureRule({ windowLength: -3 })))).not.toEqual([]);
    expect(validateRuleTable(tableOf(fixtureRule({ windowLength: 2.5 })))).not.toEqual([]);
    expect(validateRuleTable(tableOf(fixtureRule({ windowLength: 5000 })))).not.toEqual([]);
  });

  it("fails a week with no working days in it", () => {
    const problems = validateRuleTable(
      tableOf(fixtureRule({ weekendDays: [0, 1, 2, 3, 4, 5, 6] })),
    );
    expect(problems.map((p) => p.problem)).toContain(
      "Every day of the week is marked a weekend; no day could ever count.",
    );
  });

  it("fails a malformed or reversed effective period", () => {
    expect(validateRuleTable(tableOf(fixtureRule({ effectiveFrom: "2026-02-30" })))).not.toEqual([]);
    const reversed = validateRuleTable(
      tableOf(fixtureRule({ effectiveFrom: "2020-01-01", effectiveTo: "2019-01-01" })),
    );
    expect(reversed.map((p) => p.problem)).toContain("effectiveTo is earlier than effectiveFrom.");
  });

  it("fails a rule filed under the wrong jurisdiction", () => {
    const problems = validateRuleTable(tableOf(fixtureRule({ jurisdiction: "YY" })));
    expect(problems.map((p) => p.problem)).toContain(
      'Rule\'s jurisdiction "YY" does not match its entry.',
    );
  });
});
